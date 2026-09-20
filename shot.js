const puppeteer = require('puppeteer-core')

const url = process.argv[2] || 'http://127.0.0.1:3007'
const out = process.argv[3] || '/tmp/viewer.png'
const waitMs = parseInt(process.argv[4] || '8000', 10)

;(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/root/.omp/puppeteer/chrome/linux-150.0.7871.24/chrome-linux64/chrome',
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu',
      '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
      '--window-size=1280,800'
    ],
    env: { ...process.env }
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800 })
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await new Promise(r => setTimeout(r, waitMs))
  await page.screenshot({ path: out })
  await browser.close()
  console.log('saved', out)
})().catch(e => { console.error('FAIL:', e.message); process.exit(1) })
