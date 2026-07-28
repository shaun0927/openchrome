'use strict';

process.env.OPENCHROME_STANDALONE_BINARY = '1';
process.env.OPENCHROME_UPDATE_CHECK = process.env.OPENCHROME_UPDATE_CHECK || '0';

const args = process.argv.slice(2);
const fullCliCommands = new Set(['serve', 'check', 'doctor', 'verify', 'info']);
const routeToFullCli = fullCliCommands.has(args[0])
  || (args[0] === 'help' && fullCliCommands.has(args[1]));

if (routeToFullCli) {
  require('../../dist/index.js');
} else {
  require('../../dist/cli/index.js');
}
