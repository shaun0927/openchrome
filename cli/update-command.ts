import { spawnSync } from 'child_process';

const UPDATE_COMMAND = ['npm', 'install', '-g', 'openchrome-mcp@latest'] as const;

export interface UpdateCommandOptions {
  setup?: boolean;
  client?: 'claude' | 'codex' | 'vscode' | 'cursor' | 'windsurf';
  scope?: 'user' | 'project';
}

export function getUpdateCommandText(): string {
  return UPDATE_COMMAND.join(' ');
}

function run(command: string, args: string[]): number {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.error) {
    console.error(`\nFailed to run: ${[command, ...args].join(' ')}`);
    if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') {
      console.error(`${command} was not found.`);
    } else {
      console.error(result.error.message);
    }
    return 1;
  }

  return typeof result.status === 'number' ? result.status : result.signal ? 1 : 0;
}

function getSetupArgs(options: UpdateCommandOptions): string[] {
  const args = ['setup'];
  const scope = options.scope ?? 'user';
  if (options.client && options.client !== 'claude') {
    args.push('--client', options.client);
  }
  args.push('--scope', scope);
  return args;
}

export function runUpdateCommand(options: UpdateCommandOptions = {}): number {
  const setup = options.setup !== false;

  console.log(`Running: ${getUpdateCommandText()}`);
  const updateStatus = run(UPDATE_COMMAND[0], UPDATE_COMMAND.slice(1));
  if (updateStatus !== 0) {
    console.error('\nUpdate failed.');
    console.error('Run this command manually after fixing the npm error:');
    console.error(`  ${getUpdateCommandText()}`);
    return updateStatus;
  }

  console.log('\nOpenChrome package updated successfully.');

  if (!setup) {
    console.log('MCP client setup was skipped. Run "openchrome setup" when you are ready to reconfigure.');
    return 0;
  }

  const setupArgs = getSetupArgs(options);
  console.log(`\nReconfiguring MCP client to use the installed openchrome binary...`);
  console.log(`Running: openchrome ${setupArgs.join(' ')}`);
  const setupStatus = run('openchrome', setupArgs);
  if (setupStatus !== 0) {
    console.error('\nUpdate succeeded, but MCP client setup failed.');
    console.error('Run this command manually after fixing the setup error:');
    console.error(`  openchrome ${setupArgs.join(' ')}`);
    return setupStatus;
  }

  console.log('\nOpenChrome updated and MCP client configuration refreshed.');
  console.log('Restart your MCP client to load the updated server command.');
  return 0;
}
