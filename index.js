const pptr = require('puppeteer-core');
const QR = require('qrcode');
const fs = require('fs');
const fse = require('fs-extra');
const pdfMerge = require('pdf-merge');
const Progress = require('progress');
const tempy = require('tempy');
const globby = require('globby');
const util = require('util');
const exec = util.promisify(require('child_process').exec);

// globals
const TOTAL_NUMBER_OF_TICKETS = 8000000;
const BATCH_SIZE = 25008; // batch size to make
const PAGE_SIZE = 12; // size of a page.
const TEMP_DIR = tempy.directory();

const normalizeCSS = fs.readFileSync('./node_modules/normalize.css/normalize.css', 'utf8');
const paperCSS = fs.readFileSync('./node_modules/paper-css/paper.min.css', 'utf8');
const template = fs.readFileSync('template.html', 'utf8');

// base64 logos
const imaLogo = fs.readFileSync('./lib/ima-logo.jpg').toString('base64');
const pnlpLogo = fs.readFileSync('./lib/pnlp-logo.jpg').toString('base64');

async function xzPDF(name) {
  const cmd = `xz ${name}`;
  const { stdout, stderr } = await exec(cmd);
  console.log('stdout:', stdout);
  console.log('stderr:', stderr);
}

async function makeItem(id) {
  // make a data URL out of the QR code.
  const url = await QR.toDataURL(String(id));

  const ima = `data:image/jpeg;base64,${imaLogo}`;
  const pnlp = `data:image/png;base64,${pnlpLogo}`;

  return `
    <div class="item">
      <div class="tem-logo-ima">
        <img src="${ima}" style="height:75px; width:auto; margin: 0 auto;">
      </div>

      <div class="item-top">
        <i>Jeton de distribution de MILD</i>
      </div>

      <div class="item-logo-pnlp">
        <img src="${pnlp}" style="height:70px; width:auto; margin: 0 auto;">
      </div>

      <div class="item-qrcode">
        <img src="${url}" style="height:100%; width:auto; margin: 0 auto;">
      </div>

      <div class="item-hrcode">
        ${id}
      </div>
    </div>
  `;
}

const headless = true;

function extractNumberFromFileName(fname) {
  const last = fname.split('-').pop().replace('.txt', '');
  return parseInt(last, 10);
}

async function createTemplatesFromRange(start, stop, statusbar) {
  console.log('Creating text templates');
  const items = [];
  for (let i = start; i <= stop; i += 1) {
    items.push(makeItem(i));

    // after chunk is done, let's write it to disk
    if ((i % PAGE_SIZE) === 0) {
      const chunks = await Promise.all(items);

      // write to temp file
      await fse.writeFile(`${TEMP_DIR}/chunks-temp-${i}.txt`, chunks.join(''), 'utf8');

      // reset the items
      items.length = 0;
    }

    statusbar.tick();
  }
}

async function renderTemplatesFromRange(i, j, statusbar) {
  const files = [];
  const globs = await globby(`${TEMP_DIR}/chunks*.txt`);

  console.log('Sorting templates into sensible ordering');

  // order paths in a sensible order
  globs.sort((a, b) => ((extractNumberFromFileName(a) > extractNumberFromFileName(b)) ? 1 : -1));

  const browser = await pptr.launch({ executablePath: '/usr/bin/chromium-browser', headless });
  let index = 0;
  for (const glob of globs) {
    const sheet = await fse.readFile(glob, 'utf8');

    const content = template
      .replace('INJECT_NORMALIZE', normalizeCSS)
      .replace('INJECT_PAPER_CSS', paperCSS)
      .replace('INJECT_CONTENT', `<div class="sheet">${sheet}</div>`);

    const page = await browser.newPage();
    await page.setContent(content);

    const path = `${TEMP_DIR}/tickets-${index++}.pdf`;
    await page.pdf({ path, format: 'A4' });

    await page.close();

    files.push(path);

    statusbar.tick();
  }

  await browser.close();

  console.log('Consolidating all paths into a single path.');
  const fname = `tickets-${i}-${j}.pdf`;
  await pdfMerge(files, { output: fname });

  console.log(`Zipping PDFs into ${fname}.xz`);
  await xzPDF(fname);

  // delete all .txt files
  console.log(`Deleting ${globs.length} txt files`);
  await Promise.all(globs.map(path => fse.unlink(path)));

  // delete all .pdf files
  console.log(`Deleting ${files.length} pdf files`);
  await Promise.all(files.map(path => fse.unlink(path)));
}

async function makeBatchOfTickets(i, j, statusbar) {
  console.log(`Making a batch of tickets (${i} - ${j})`);
  await createTemplatesFromRange(i, j, statusbar);
  await renderTemplatesFromRange(i, j, statusbar);
}

(async () => {
  console.log('Starting PDF generation...');
  try {
    console.log('Starting creating text templates...');

    const statusbar = new Progress('[:bar] :percent :etas', { total: (TOTAL_NUMBER_OF_TICKETS * 2) });

    let i = 1;
    while (i <= TOTAL_NUMBER_OF_TICKETS) {
      await makeBatchOfTickets(i, BATCH_SIZE, statusbar);
      i += BATCH_SIZE;
    }

    console.log('Done!');
  } catch (e) {
    console.log('e:', e);
  }
})();
