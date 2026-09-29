'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs, HELP } = require('./args');
const { collectReport } = require('./collect');
const { renderConsole } = require('./reporters/console');
const { writeCsv } = require('./reporters/csv');
const { renderHtml } = require('./reporters/html');

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) { process.stdout.write(HELP); return 0; }
  if (opts.version) { console.log(require('../package.json').version); return 0; }

  const log = opts.quiet ? () => {} : (msg) => process.stderr.write(msg + '\n');
  const report = await collectReport(opts, log);

  // ---- output ----------------------------------------------------------------------------------
  if (opts.formats.includes('console')) process.stdout.write(renderConsole(report, opts));

  const fileFormats = opts.formats.filter((f) => f !== 'console');
  if (fileFormats.length) {
    const outDir = path.resolve(opts.out);
    fs.mkdirSync(outDir, { recursive: true });
    const written = [];
    if (fileFormats.includes('json')) {
      const file = path.join(outDir, 'git-report.json');
      fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');
      written.push(file);
    }
    if (fileFormats.includes('csv')) written.push(...writeCsv(report, outDir));
    if (fileFormats.includes('html')) {
      const file = path.join(outDir, 'git-report.html');
      fs.writeFileSync(file, renderHtml(report), 'utf8');
      written.push(file);
    }
    log('\nReport files:');
    for (const f of written) log('  ' + f);
  }
  return 0;
}

module.exports = { main };
