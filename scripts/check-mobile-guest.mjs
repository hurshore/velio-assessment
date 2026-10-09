import { spawn, execFile } from 'node:child_process';
import { localApiBase } from './local-api.mjs';

if (process.platform !== 'darwin' || !process.argv[2]) {
  console.error('Usage: node scripts/check-mobile-guest.mjs <booted-ios-simulator-id> [integration-test-file]');
  process.exit(1);
}
if (process.env.API_BASE_URL === undefined) {
  const { existsSync } = await import('node:fs');
  if (existsSync('.env')) process.loadEnvFile('.env');
}
const device = process.argv[2];
const child = spawn('flutter', ['test', process.argv[3] ?? 'integration_test/public_guest_test.dart', '-d', device,
  `--dart-define=API_BASE_URL=${localApiBase(process.env)}`], { cwd: 'mobile', stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
const opened = new Set();
function receive(bytes) {
  process.stdout.write(bytes);
  output = (output + bytes.toString()).slice(-8000);
  for (const match of output.matchAll(/VELIO_LINK_READY=(velio:\/\/invite\/[0-9A-HJKMNP-TV-Z]{12}\?journey=[0-9a-f-]{36})/g)) {
    if (opened.has(match[1])) continue;
    opened.add(match[1]);
    execFile('xcrun', ['simctl', 'openurl', device, match[1]], error => {
      if (error) { console.error('Native link failed:', error.message); child.kill('SIGINT'); }
      else { console.log('Opened native invitation URL on simulator. Accept the iOS Open prompt if shown.'); }
    });
  }
}
child.stdout.on('data', receive);
child.stderr.on('data', receive);
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
