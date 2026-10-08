import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { localApiBase } from './local-api.mjs';

if (existsSync('.env')) process.loadEnvFile('.env');
const child = spawn('flutter', ['run', `--dart-define=API_BASE_URL=${localApiBase(process.env)}`, ...process.argv.slice(2)], { cwd: 'mobile', stdio: 'inherit' });
child.on('error', error => { console.error('Flutter launch failed:', error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
