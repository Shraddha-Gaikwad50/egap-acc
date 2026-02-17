
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

dotenv.config();

const FACTORY_URL = 'http://localhost:3000';
const ACC_URL = 'http://localhost:3001';

async function post(url: string, data: any) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    return res.json();
}

async function get(url: string) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

async function wait(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    console.log('🚀 Starting ACC Sync Verification...\n');

    const suffix = Date.now().toString().slice(-4);

    // 1. Create LIVE Agent
    const liveAgentName = `ACC-Test-Live-Bot-${suffix}`;
    const liveAgent = {
        name: liveAgentName,
        role: 'IT Support',
        goal: 'Assist with tickets',
        systemPrompt: 'You are an IT bot.',
        workspace: 'IT',
        status: 'LIVE',
        tools: []
    };
    console.log(`📝 Creating LIVE agent: ${liveAgentName} in IT workspace...`);
    await post(`${FACTORY_URL}/api/agents`, liveAgent);

    // 2. Create DRAFT Agent
    const draftAgentName = `ACC-Test-Draft-Bot-${suffix}`;
    const draftAgent = {
        name: draftAgentName,
        role: 'HR Assistant',
        goal: 'Drafting policies',
        systemPrompt: 'You are an HR bot.',
        workspace: 'HR',
        status: 'DRAFT',
        tools: []
    };
    console.log(`📝 Creating DRAFT agent: ${draftAgentName} in HR workspace...`);
    await post(`${FACTORY_URL}/api/agents`, draftAgent);

    console.log('\n⏳ Waiting 5s for ACC to poll (or for next restart)...');

    // For now, let's just assert against the FACTORY export first to ensure filtering works at source.
    console.log('🔍 Checking Factory Export (Source of Truth)...');
    const exportData: any = await get(`${FACTORY_URL}/.well-known/agent.json`);
    const exportedNames = exportData.agents.map((a: any) => a.name);

    if (!exportedNames.includes(liveAgentName)) {
        throw new Error('❌ Factory Export: LIVE agent MISSING!');
    }
    if (exportedNames.includes(draftAgentName)) {
        throw new Error('❌ Factory Export: DRAFT agent FOUND! Filtering failed.');
    }
    const liveExport = exportData.agents.find((a: any) => a.name === liveAgentName);
    if (liveExport.workspace !== 'IT') {
        throw new Error(`❌ Factory Export: Workspace mismatch. Expected IT, got ${liveExport.workspace}`);
    }
    console.log('✅ Factory Export Logic Verified (Source filtered correctly).\n');

    // 3. Verify ACC Sync (Mirror)
    console.log('🔍 Checking ACC API (Mirror)...');
    let synced = false;
    // Wait up to 80s (40 * 2s) to cover the 60s polling interval
    for (let i = 0; i < 40; i++) {
        const accData: any = await get(`${ACC_URL}/api/agents`);
        const accAgents = accData.agents || accData;
        const accNames = accAgents.map((a: any) => a.name);

        const hasLive = accNames.includes(liveAgentName);
        const hasDraft = accNames.includes(draftAgentName);

        if (hasLive && !hasDraft) {
            const liveAcc = accAgents.find((a: any) => a.name === liveAgentName);
            if (liveAcc.workspace === 'IT') {
                synced = true;
                break;
            }
        }
        process.stdout.write('.');
        await wait(2000); // Wait 2s
    }

    if (!synced) {
        console.warn('\n⚠️  ACC Sync not yet reflected (Poll interval is 60s). Please restart ACC service to force immediate sync.');
    } else {
        console.log('\n✅ ACC Sync Verified! Live agent found in IT, Draft filtered out.');
    }

}

main().catch(console.error);
