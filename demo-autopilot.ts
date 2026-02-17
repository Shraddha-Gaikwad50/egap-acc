
import https from 'https';

const INGRESS_URL = 'https://egap-ingress-910005263485.us-central1.run.app/webhook';

// Function to send a request
function sendEvent(name: string, delayMs: number, payload: any, logMessage: string) {
    setTimeout(async () => {
        console.log(logMessage);

        try {
            const req = https.request(INGRESS_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                }
            }, (res) => {
                let data = '';
                res.on('data', (chunk) => {
                    data += chunk;
                });
                res.on('end', () => {
                    console.log(`[${name}] Status: ${res.statusCode} | Response: ${data}`);
                });
            });

            req.on('error', (e) => {
                console.error(`[${name}] Request Error: ${e.message}`);
            });

            req.write(JSON.stringify(payload));
            req.end();

        } catch (error) {
            console.error(`[${name}] Error:`, error);
        }

    }, delayMs);
}

// T=0s (The Trigger)
sendEvent('TRIGGER', 0, {
    source: 'github',
    payload: {
        repo: 'egap-core',
        sender: 'aditya',
        event: 'push'
    }
}, "🚀 [DEMO] Developer pushes code to GitHub...");

// T=2s (The Chaos)
sendEvent('CHAOS', 2000, {
    source: 'slack',
    payload: {
        channel: '#ops',
        text: 'DB Connection Failed'
    }
}, "🚨 [DEMO] Critical Alert received from Slack...");

// T=4s (The Security Check)
sendEvent('SECURITY', 4000, {
    source: 'unknown',
    payload: 'DROP TABLE'
}, "🛡️ [DEMO] Suspicious activity detected...");
