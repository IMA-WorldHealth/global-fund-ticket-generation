const pptr = require('puppeteer-core');
const QR = require('qrcode');
const fs = require('fs');
const fse = require('fs-extra');
const chunk = require('lodash.chunk');
const pdfMerge = require('pdf-merge');
const progress = require('progress');
const tempy = require('tempy');
const globby = require('globby');

// globals
const NUM_TICKETS = 150;
const CHUNK_SIZE = 10;
const TEMP_DIR = tempy.directory();

const normalizeCSS = fs.readFileSync('./node_modules/normalize.css/normalize.css', 'utf8');
const paperCSS = fs.readFileSync('./node_modules/paper-css/paper.min.css', 'utf8');
const template = fs.readFileSync('template.html', 'utf8');

// base64 logos
const imaLogo = fs.readFileSync('./lib/ima-logo.jpg').toString('base64');
const pnlpLogo = fs.readFileSync('./lib/pnlp-logo.jpg').toString('base64');

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

(async () => {
  console.log('Starting PDF generation...');
  try {
    const browser = await pptr.launch({ executablePath: '/usr/bin/chromium-browser', headless });

    console.log('Starting item rendering...');

    const renderingBar = new progress('[:bar] :percent :etas', { total : NUM_TICKETS });
    const items = [];

    for (let i = 1; i <= NUM_TICKETS; i++) {
      items.push(makeItem(i));

      // after chunk is done, let's write it to disk
      if ((i % CHUNK_SIZE) === 0) {
        const chunks = await Promise.all(items);

        // write to temp file
        await fse.writeFile(`${TEMP_DIR}/chunks-temp-${i}.txt`, chunks.join(''), 'utf8');

        // reset the items
        items.length = 0;
      }

      renderingBar.tick();
    }

    // these are all elements to be displayed.
    console.log('Rendered all pages into temp files');
    console.log('Loading an rendering temp files into PDFs');

    let index = 1;
    const files = [];
    let globs = await globby(`${TEMP_DIR}/chunks*.txt`);

    console.log('Sorting templates into sensible ordering');

    // order paths in a sensible order
    globs.sort((a, b) => (extractNumberFromFileName(a) > extractNumberFromFileName(b)) ? 1 : -1);

    const bar = new progress('[:bar] :percent :etas', { total : globs.length })

    for (const glob of globs) {
      const sheet = await fse.readFile(glob, 'utf8');

      const content = template
        .replace('INJECT_NORMALIZE', normalizeCSS)
        .replace('INJECT_PAPER_CSS', paperCSS)
        .replace('INJECT_CONTENT', `<div class="sheet">${sheet}</div>`);

      const page = await browser.newPage();
      await page.setContent(content);

      const path = `${TEMP_DIR}/tickets-${index++}.pdf`;
      await page.pdf({path, format: 'A4'});

      await page.close();

      bar.tick();

      files.push(path);
    }

    await browser.close();

    console.log('Consolidating all paths into a single path.');
    await pdfMerge(files, {output : 'tickets.pdf'});

    console.log('Done!  Content available at tickets.pdf');
  } catch (e) {
    console.log('e:', e);
  }
})();
