
import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

dotenv.config();
const prisma = new PrismaClient();

const FACTORY_URL = 'http://localhost:3000';
const INGRESS_URL = 'http://localhost:8080/webhook';

// Helper for HTTP requests
async function post(url: string, data: any) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    return res.json();
}

async function put(url: string, data: any) {
    const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    return res.json();
}

async function check(name: string, fn: () => Promise<boolean | void>) {
    process.stdout.write(`⏳ Checking: ${name}... `);
    try {
        const result = await fn();
        if (result === false) throw new Error('Assertion failed');
        console.log('✅ PASS');
    } catch (e: any) {
        console.log('❌ FAIL');
        console.error(`   Error: ${e.message}`);
        process.exit(1);
    }
}

async function wait(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    console.log('🚀 Starting Final Regression Test\n');

    let agentId = '';
    const agentName = 'Test-Bot-Beta';
    const agentRole = 'qa-bot'; // Unique role for webhook targeting

    // Cleanup first
    try {
        await prisma.agent.delete({ where: { name: agentName } });
    } catch { }

    // 1. Workspace & Draft Check
    await check('Create Draft Agent in QA_Team Workspace', async () => {
        const payload = {
            name: agentName,
            role: agentRole,
            goal: 'Test regression',
            systemPrompt: 'You are a test bot v1',
            workspace: 'QA_Team',
            knowledgeBaseId: 'kb-test-001',
            status: 'DRAFT',    // <--- Key Field
            tools: []
        };

        const res: any = await post(`${FACTORY_URL}/api/agents`, payload);
        if (!res.id) throw new Error('No ID returned');
        agentId = res.id;

        // Verify in DB
        const dbAgent = await prisma.agent.findUnique({ where: { id: agentId } });
        if (!dbAgent) throw new Error('Agent not found in DB');
        if (dbAgent.workspace !== 'QA_Team') throw new Error(`Workspace mismatch: ${dbAgent.workspace}`);
        if (dbAgent.status !== 'DRAFT') throw new Error(`Status mismatch: ${dbAgent.status}`);
        if (dbAgent.knowledgeBaseId !== 'kb-test-001') throw new Error(`KB ID mismatch`);

        return true;
    });

    // 2. Versioning Check
    await check('Update System Prompt & Check Version History', async () => {
        const payload = {
            name: agentName,
            role: agentRole,
            goal: 'Test regression',
            systemPrompt: 'You are a test bot v2', // Changed
            workspace: 'QA_Team',
            knowledgeBaseId: 'kb-test-001',
            status: 'DRAFT',
            tools: []
        };

        await put(`${FACTORY_URL}/api/agents/${agentId}`, payload);

        // Verify History
        const history = await prisma.promptHistory.findMany({
            where: { agentId },
            orderBy: { version: 'desc' }
        });

        // Current prompt is v2 (live in Agent table), History stores PREVIOUS versions or current snapshot depending on logic.
        // My implementation adds to history on update. 
        // Let's check if we have an entry.
        if (history.length === 0) throw new Error('No history entries found');
        // Check if v1 is preserved
        const v1 = history.find(h => h.prompt.includes('v1'));
        if (!v1) throw new Error('Version 1 prompt not found in history');

        return true;
    });

    // 3. Safety Check: Draft Agents should be IGNORED
    await check('Safety: Draft Agents Ignore Webhooks', async () => {
        // Send webhook
        const webhookPayload = {
            source: agentRole, // Matches agent role
            payload: { message: "Hello Draft Agent" }
        };

        // Hit Ingress (simulating external event)
        // Note: Ingress is async via Pub/Sub to Orchestrator. We must wait.
        await post(INGRESS_URL, webhookPayload);

        console.log('   (Waiting 5s for async processing...)');
        await wait(5000);

        // Check if Task was created
        // Since status is DRAFT, Orchestrator should log "No agent found" and NOT create a task.
        const tasks = await prisma.task.findMany({
            where: { agentId },
            orderBy: { createdAt: 'desc' }
        });

        // We expect 0 tasks for this agent
        if (tasks.length > 0) throw new Error(`Safety Failure: Orchestrator created ${tasks.length} task(s) for a DRAFT agent!`);

        return true;
    });

    // 4. Live Check: Publish & Verify
    await check('Live: Publish Agent & Verify Processing', async () => {
        // Set to LIVE
        const payload = {
            name: agentName,
            role: agentRole,
            goal: 'Test regression',
            systemPrompt: 'You are a test bot v2',
            workspace: 'QA_Team',
            knowledgeBaseId: 'kb-test-001',
            status: 'LIVE', // <--- Publishing
            tools: []
        };
        await put(`${FACTORY_URL}/api/agents/${agentId}`, payload);

        // Send webhook again
        const webhookPayload = {
            source: agentRole,
            payload: { message: "Hello Live Agent" }
        };
        await post(INGRESS_URL, webhookPayload);

        console.log('   (Waiting 5s for async processing...)');
        await wait(5000);

        // Check if Task was created
        const tasks = await prisma.task.findMany({
            where: { agentId },
            orderBy: { createdAt: 'desc' }
        });

        if (tasks.length === 0) throw new Error('Live Failure: Orchestrator DID NOT create a task for a LIVE agent.');

        return true;
    });

    console.log('\n🎉 ALL REGRESSION TESTS PASSED!');
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
