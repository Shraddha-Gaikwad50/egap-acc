import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { PubSub } from '@google-cloud/pubsub';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const server = Fastify({ logger: true });
const prisma = new PrismaClient({
  datasources: {
    db: {
      url: (process.env.DATABASE_URL || '') + (process.env.DATABASE_URL?.includes('?') ? '&' : '?') + 'connection_limit=10',
    },
  },
});

const pubsub = new PubSub({ projectId: process.env.PROJECT_ID });
const topicName = process.env.TOPIC_NAME || 'egap-ingress-topic';

// Enable CORS so our future frontend can talk to this
server.register(cors);

// Serve static files from public/
server.register(fastifyStatic, {
  root: path.join(__dirname, '..', 'public'),
  prefix: '/',
});

// 1. Health Check
server.get('/api/health', async () => {
  return { status: 'ACC Online', system: 'EGAP Command Plane' };
});

// 2. Workforce Map — A2A Orchestration View (Architecture Spec v1.0)
server.get('/api/agents', async () => {
  const agents = await prisma.agent.findMany({
    include: {
      tools: true,
      deployments: true,
      tasks: {
        where: { status: 'PENDING' },
        select: { id: true },
      },
    },
  });

  const workforceMap = agents.map((agent: any) => {
    const activeDeployment = agent.deployments?.find((d: any) => d.status === 'ACTIVE');
    return {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      goal: agent.goal,
      isActive: agent.isActive,
      version: `v${agent.currentVersion}`,
      budgetUsd: agent.budgetUsd,
      // A2A fields
      adkResourceName: agent.adkResourceName || null,
      agentCardUrl: agent.agentCardUrl || null,
      // Capabilities
      tools: agent.tools.map((t: any) => ({
        name: t.name,
        actionType: t.actionType || 'READ',
        mcpServerUrl: t.mcpServerUrl || null,
      })),
      hasWriteTools: agent.tools.some((t: any) => t.actionType === 'WRITE'),
      // Status
      deploymentStatus: activeDeployment ? 'DEPLOYED' : 'NOT_DEPLOYED',
      pendingTasks: agent.tasks?.length || 0,
      // A2A Endpoints
      endpoints: {
        chat: `/api/chat`,
        resume: `/api/agents/${agent.id}/resume`,
        card: `/api/agents/${agent.id}/card`,
      },
    };
  });

  return {
    count: agents.length,
    agents: workforceMap,
  };
});

// FRS: Zombie Detection — tasks PENDING longer than this are flagged as stuck
const ZOMBIE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

// 3. Task Queue (List PENDING tasks for HITL governance)
server.get('/api/tasks', async () => {
  const tasks = await prisma.task.findMany({
    where: { status: 'PENDING' },
    include: { agent: true },
    orderBy: { createdAt: 'desc' },
  });
  const now = Date.now();
  return {
    count: tasks.length,
    tasks: tasks.map(t => ({
      ...t,
      isZombie: now - new Date(t.createdAt).getTime() > ZOMBIE_THRESHOLD_MS,
    })),
  };
});

// 3b. Zombie Detection endpoint — list only stuck tasks
server.get('/api/tasks/zombies', async () => {
  const cutoff = new Date(Date.now() - ZOMBIE_THRESHOLD_MS);
  const zombies = await prisma.task.findMany({
    where: { status: 'PENDING', createdAt: { lt: cutoff } },
    include: { agent: true },
    orderBy: { createdAt: 'asc' },
  });
  return {
    count: zombies.length,
    threshold: `${ZOMBIE_THRESHOLD_MS / 60000} minutes`,
    zombies,
  };
});

// 4. Approve a Task → use A2A Resume Protocol (Architecture Spec v1.0)
server.post<{ Params: { id: string }; Body: { feedback?: string } }>('/api/tasks/:id/approve', async (request) => {
  const approveStart = Date.now();
  const task = await prisma.task.findUnique({
    where: { id: request.params.id },
    include: { agent: true },
  });

  if (!task) throw new Error('Task not found');

  const traceId = (task.inputPayload as any)?.traceId || randomUUID();
  const feedback = (request.body as any)?.feedback || undefined;

  // A2A Resume: Call Factory's resume endpoint for the agent
  try {
    const resumeRes = await fetch(`${FACTORY_URL}/api/agents/${task.agentId}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskId: task.id,
        feedback,
      }),
    });

    if (!resumeRes.ok) {
      console.error(`❌ A2A Resume failed: ${resumeRes.statusText}`);
    } else {
      const resumeResult = await resumeRes.json() as any;
      console.log(`✅ A2A Resume completed: ${resumeResult?.status}`);
    }
  } catch (err: any) {
    console.error(`❌ A2A Resume call failed: ${err.message}`);
    // Fall back to Pub/Sub if A2A Resume fails
    const resumePayload = {
      type: 'RESUME',
      taskId: task.id,
      agentId: task.agentId,
      traceId,
    };
    await pubsub.topic(topicName).publishMessage({
      data: Buffer.from(JSON.stringify(resumePayload)),
      attributes: { traceId },
    });
    console.log(`📤 Fallback: Published RESUME via Pub/Sub for Task ${task.id}`);
  }

  // FRS: Record approve trace span
  await prisma.traceSpan.create({
    data: {
      traceId,
      service: 'acc',
      operation: 'approve_task_a2a',
      durationMs: Date.now() - approveStart,
      metadata: { taskId: task.id, agentName: task.agent.name, protocol: 'a2a/1.0' },
    },
  });

  return { ...task, status: 'APPROVED', protocol: 'a2a/1.0' };
});

// 5. Reject a Task
server.post<{ Params: { id: string } }>('/api/tasks/:id/reject', async (request) => {
  const rejectStart = Date.now();
  const task = await prisma.task.update({
    where: { id: request.params.id },
    data: { status: 'REJECTED' },
    include: { agent: true },
  });

  // Recover traceId from task input payload
  const traceId = (task.inputPayload as any)?.traceId || randomUUID();

  // FRS: Record reject trace span
  await prisma.traceSpan.create({
    data: {
      traceId,
      service: 'acc',
      operation: 'reject_task',
      durationMs: Date.now() - rejectStart,
      metadata: { taskId: task.id, agentName: task.agent.name },
    },
  });

  return task;
});

// 6. FRS Cost Accounting — per-agent token usage summary
server.get('/api/usage', async () => {
  const logs = await prisma.usageLog.findMany({
    include: { agent: { select: { id: true, name: true, role: true } } },
    orderBy: { createdAt: 'desc' },
  });

  // Aggregate by agent
  const byAgent: Record<string, { name: string; role: string; totalTokens: number; totalCost: number; actions: number }> = {};
  for (const log of logs) {
    if (!byAgent[log.agentId]) {
      byAgent[log.agentId] = { name: log.agent.name, role: log.agent.role, totalTokens: 0, totalCost: 0, actions: 0 };
    }
    byAgent[log.agentId].totalTokens += log.tokens;
    byAgent[log.agentId].totalCost += log.costUsd;
    byAgent[log.agentId].actions += 1;
  }

  return {
    totalLogs: logs.length,
    totalTokens: logs.reduce((sum, l) => sum + l.tokens, 0),
    totalCostUsd: Math.round(logs.reduce((sum, l) => sum + l.costUsd, 0) * 10000) / 10000,
    byAgent: Object.entries(byAgent).map(([id, data]) => ({
      agentId: id,
      ...data,
      totalCost: Math.round(data.totalCost * 10000) / 10000,
    })),
  };
});

// ── FRS: Agent Card Auto-Registration ────────────────────────────────
const FACTORY_URL = process.env.FACTORY_URL || 'http://localhost:3000';
const DISCOVERY_INTERVAL_MS = 60_000; // poll every 60s

interface DiscoveryStatus {
  lastRun: string | null;
  agentsDiscovered: number;
  agentsSynced: string[];
  error: string | null;
}

const discoveryStatus: DiscoveryStatus = {
  lastRun: null,
  agentsDiscovered: 0,
  agentsSynced: [],
  error: null,
};

async function discoverAgents(): Promise<void> {
  try {
    const url = `${FACTORY_URL}/.well-known/agent.json`;
    console.log(`🔍 Discovering agents via A2A Agent Card from ${url}...`);
    const res = await fetch(url);
    if (!res.ok) {
      discoveryStatus.error = `HTTP ${res.status} from Agent Card`;
      console.log(`⚠️  Agent Card discovery failed: ${discoveryStatus.error}`);
      return;
    }

    const card = await res.json() as {
      protocol?: string;
      platform?: string;
      agents?: Array<{
        name: string;
        description: string;
        url: string | null;
        version: string;
        protocols: string[];
        capabilities: {
          tools: Array<{ name: string; actionType: string }>;
          hitl: boolean;
        };
        status: string;
        adkResourceName: string | null;
        endpoints: { chat: string; resume: string; card: string };
      }>;
    };

    if (!card.agents || !Array.isArray(card.agents)) {
      discoveryStatus.error = 'No agents array in Agent Card response';
      return;
    }

    discoveryStatus.agentsDiscovered = card.agents.length;
    discoveryStatus.agentsSynced = [];
    discoveryStatus.error = null;

    for (const agent of card.agents) {
      const existing = await prisma.agent.findUnique({ where: { name: agent.name } });
      if (!existing) {
        const [role, goal] = (agent.description || '').split(' — ');
        await prisma.agent.create({
          data: {
            name: agent.name,
            role: role || 'Auto-discovered',
            goal: goal || 'Discovered via A2A Agent Card',
            systemPrompt: `Auto-registered from A2A Agent Card (${agent.name})`,
            agentCardUrl: `${FACTORY_URL}/.well-known/agent.json`,
            adkResourceName: agent.adkResourceName || null,
          },
        });
        console.log(`✅ Auto-registered new agent via A2A: ${agent.name}`);
      } else if (agent.adkResourceName && !existing.adkResourceName) {
        // Sync ADK resource name if it was deployed after initial discovery
        await prisma.agent.update({
          where: { name: agent.name },
          data: { adkResourceName: agent.adkResourceName },
        });
      }
      discoveryStatus.agentsSynced.push(agent.name);
    }

    discoveryStatus.lastRun = new Date().toISOString();
    console.log(`🔍 A2A Discovery complete: ${card.agents.length} agents (protocol: ${card.protocol || 'unknown'})`);
  } catch (err: any) {
    discoveryStatus.error = err.message || 'Unknown error';
    console.log(`⚠️  Agent Card discovery error: ${discoveryStatus.error}`);
  }
}

// 7. Discovery Status endpoint
server.get('/api/discovery', async () => {
  return {
    factoryUrl: FACTORY_URL,
    pollingInterval: `${DISCOVERY_INTERVAL_MS / 1000}s`,
    ...discoveryStatus,
  };
});

// 8. FRS Trace Map — list recent traces with their spans
server.get('/api/traces', async (request) => {
  const query = request.query as { limit?: string };
  const limit = Math.min(Number(query.limit) || 20, 100);

  // Get the most recent distinct traceIds
  const recentSpans = await prisma.traceSpan.findMany({
    orderBy: { startedAt: 'desc' },
    take: limit * 5, // over-fetch to group
  });

  // Group spans by traceId
  const traceMap = new Map<string, typeof recentSpans>();
  for (const span of recentSpans) {
    if (!traceMap.has(span.traceId)) traceMap.set(span.traceId, []);
    traceMap.get(span.traceId)!.push(span);
  }

  // Build trace summaries
  const traces = Array.from(traceMap.entries())
    .slice(0, limit)
    .map(([traceId, spans]) => {
      const root = spans.find(s => !s.parentId) || spans[0];
      const services = [...new Set(spans.map(s => s.service))];
      const hasError = spans.some(s => s.status === 'ERROR');
      return {
        traceId,
        rootService: root.service,
        rootOperation: root.operation,
        services,
        spanCount: spans.length,
        totalDurationMs: root.durationMs,
        status: hasError ? 'ERROR' : 'OK',
        startedAt: root.startedAt,
        spans: spans.map(s => ({
          id: s.id,
          parentId: s.parentId,
          service: s.service,
          operation: s.operation,
          status: s.status,
          durationMs: s.durationMs,
          metadata: s.metadata,
          startedAt: s.startedAt,
        })),
      };
    });

  return { count: traces.length, traces };
});

// ── Phase 5: Final Reconciliation ────────────────────────────────────
const INGRESS_URL = process.env.INGRESS_URL || 'http://localhost:8080';

// 9. Reconciliation Report — compare ingress vs egress
server.get('/api/reconciliation', async () => {
  // 1. Query task statuses from our DB
  const allTasks = await prisma.task.findMany({
    include: { agent: { select: { name: true } } },
  });

  const approved = allTasks.filter(t => t.status === 'APPROVED');
  const rejected = allTasks.filter(t => t.status === 'REJECTED');
  const pending = allTasks.filter(t => t.status === 'PENDING');

  // 2. Query trace spans for ingress events (proxy for messages received)
  const ingressSpans = await prisma.traceSpan.findMany({
    where: { service: 'ingress', operation: 'webhook_receive' },
  });

  // 3. Try to fetch live ingress audit counters
  let ingressStats = { totalReceived: 0, totalPublished: 0, totalFailed: 0, uptime: 'N/A' };
  try {
    const res = await fetch(`${INGRESS_URL}/api/stats`);
    if (res.ok) ingressStats = await res.json() as typeof ingressStats;
  } catch { /* ingress offline — use span count as fallback */ }

  const totalIngress = ingressStats.totalReceived || ingressSpans.length;
  const totalResolved = approved.length + rejected.length;
  const gap = totalIngress - totalResolved;

  // 4. Get cost totals
  const usageLogs = await prisma.usageLog.findMany();
  const totalTokens = usageLogs.reduce((s, l) => s + l.tokens, 0);
  const totalCost = Math.round(usageLogs.reduce((s, l) => s + l.costUsd, 0) * 10000) / 10000;

  return {
    generatedAt: new Date().toISOString(),
    ingress: {
      totalReceived: totalIngress,
      totalPublished: ingressStats.totalPublished || ingressSpans.length,
      totalFailed: ingressStats.totalFailed,
      liveStats: ingressStats,
    },
    egress: {
      totalTasks: allTasks.length,
      approved: approved.length,
      rejected: rejected.length,
      pending: pending.length,
    },
    reconciliation: {
      totalIngress,
      totalResolved,
      gap,
      status: gap === 0 ? 'RECONCILED' : pending.length > 0 ? 'PENDING_APPROVAL' : 'UNRECONCILED',
    },
    cost: {
      totalTokens,
      totalCostUsd: totalCost,
    },
  };
});

// 10. Autonomy Rate — Architecture Spec: (total_completions - hitl_interventions) / total_completions
server.get('/api/autonomy-rate', async () => {
  const [totalMessages, totalResponses, totalHitlTasks, completedTasks, rejectedTasks] =
    await Promise.all([
      prisma.message.count({ where: { role: 'user' } }),
      prisma.message.count({ where: { role: 'assistant' } }),
      prisma.task.count(),
      prisma.task.count({ where: { status: 'COMPLETED' } }),
      prisma.task.count({ where: { status: 'REJECTED' } }),
    ]);

  const totalCompletions = totalResponses;
  const hitlInterventions = totalHitlTasks;
  const autonomyRate = totalCompletions > 0
    ? Math.round(((totalCompletions - hitlInterventions) / totalCompletions) * 10000) / 100
    : 100;

  return {
    autonomyRate: `${autonomyRate}%`,
    totalCompletions,
    hitlInterventions,
    completedTasks,
    rejectedTasks,
    totalUserMessages: totalMessages,
  };
});

const start = async () => {
  try {
    // Run on port 3001 so it doesn't conflict with other things
    await server.listen({ port: 3001, host: '0.0.0.0' });
    console.log('🛸 EGAP Command Center running at http://localhost:3001');

    // FRS: Run initial agent card discovery, then poll periodically
    discoverAgents();
    setInterval(discoverAgents, DISCOVERY_INTERVAL_MS);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();
