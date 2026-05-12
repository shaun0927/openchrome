/**
 * `openchrome contract teach` — register a screenshot exemplar against a
 * class in the on-disk registry. Threshold is recomputed on each teach.
 *
 * The CLI tsconfig has `rootDir = ./cli` so we can't import `src/` modules
 * directly. The implementation lives in `src/contracts/screenshot-class.ts`
 * and we pull it in via a runtime `require()` against the compiled output —
 * the same pattern used by `admin-keys.ts`.
 */

import { Command } from 'commander';

interface ScreenshotClassMetadata {
  classId: string;
  threshold: number;
  exemplarCount: number;
  hashBits: 64;
}

interface ContractsModule {
  teachClass(
    classId: string,
    pngPath: string,
    rootDir?: string,
  ): Promise<ScreenshotClassMetadata>;
  loadClass(classId: string, rootDir?: string): Promise<{
    classId: string;
    threshold: number;
    exemplarCount: number;
    exemplars: { name: string }[];
  }>;
  defaultClassesDir(): string;
}

function loadContractsModule(): ContractsModule {
  // Resolve against `dist/contracts/index.js` at runtime.
  // The CLI compiles to `dist/cli/index.js`, so the relative path is
  // `../contracts/index.js` once we're running from disk.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('../contracts/index.js');
  return mod as ContractsModule;
}

export function registerContractCommand(program: Command): void {
  const contract = program
    .command('contract')
    .description('Outcome-contract authoring helpers (issue #705).');

  contract
    .command('teach')
    .description('Register a PNG exemplar with a screenshot class and recompute its threshold.')
    .argument('<class_id>', 'Class identifier (alphanumerics + . _ -)')
    .argument('<png_path>', 'Path to a PNG screenshot to use as an exemplar')
    .option('--root <dir>', 'Override registry root (defaults to ~/.openchrome/screenshot-classes/)')
    .action(async (classId: string, pngPath: string, options: { root?: string }) => {
      let mod: ContractsModule;
      try {
        mod = loadContractsModule();
      } catch (err) {
        console.error(
          '❌ Failed to load contracts module. Did you run `npm run build`?',
        );
        console.error(`   ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }

      try {
        const metadata = await mod.teachClass(classId, pngPath, options.root);
        const rootDir = options.root || mod.defaultClassesDir();
        console.error(`✓ Exemplar added to class '${classId}' under ${rootDir}`);
        console.error(`  exemplars : ${metadata.exemplarCount}`);
        console.error(`  threshold : ${metadata.threshold} (Hamming, /64)`);
        // stdout = machine-readable result. The CLI binary is a separate
        // process from the MCP server, so writing JSON to stdout here does
        // not corrupt the JSON-RPC stream warned about in CLAUDE.md.
        console.log(JSON.stringify(metadata));
      } catch (err) {
        console.error(`❌ teach failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  contract
    .command('show')
    .description('Print metadata for a screenshot class (exemplars, threshold).')
    .argument('<class_id>', 'Class identifier')
    .option('--root <dir>', 'Override registry root')
    .option('--json', 'Emit JSON instead of a table')
    .action(async (classId: string, options: { root?: string; json?: boolean }) => {
      let mod: ContractsModule;
      try {
        mod = loadContractsModule();
      } catch (err) {
        console.error('❌ Failed to load contracts module. Did you run `npm run build`?');
        console.error(`   ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }

      try {
        const loaded = await mod.loadClass(classId, options.root);
        if (options.json) {
          // stdout = machine-readable; see comment in `teach` action.
          console.log(
            JSON.stringify(
              {
                classId: loaded.classId,
                threshold: loaded.threshold,
                exemplarCount: loaded.exemplarCount,
                exemplars: loaded.exemplars.map((e) => e.name),
              },
              null,
              2,
            ),
          );
          return;
        }
        const rootDir = options.root || mod.defaultClassesDir();
        console.error(`Class       : ${loaded.classId}`);
        console.error(`Root        : ${rootDir}`);
        console.error(`Threshold   : ${loaded.threshold}`);
        console.error(`Exemplars   : ${loaded.exemplarCount}`);
        for (const e of loaded.exemplars) {
          console.error(`  - ${e.name}`);
        }
      } catch (err) {
        console.error(`❌ show failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
