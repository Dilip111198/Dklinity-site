/*
  fetch-linkedin.js
  Scrapes public LinkedIn company posts and writes linkedin-feed.json next to index.html.

  Notes:
  - LinkedIn frequently changes DOM and may block bots. For best reliability, set the env var LINKEDIN_COOKIES_JSON
    to a JSON array of cookies captured from a logged-in browser session for linkedin.com.
  - Without cookies, the script will attempt to scrape public content and may get partial results.
  - Configure a GitHub Action with this script and (optionally) a secret LINKEDIN_COOKIES_JSON for stable results.
*/

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const COMPANY_URL = process.env.LINKEDIN_COMPANY_URL || 'https://www.linkedin.com/company/dklinity/';
const OUTPUT_PATH = path.resolve(__dirname, 'linkedin-feed.json');
const MAX_POSTS = Number(process.env.MAX_POSTS || 20);
const SCROLL_TIMEOUT_MS = Number(process.env.SCROLL_TIMEOUT_MS || 30000);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function setCookiesIfProvided(page) {
  const cookiesJson = process.env.LINKEDIN_COOKIES_JSON;
  if (!cookiesJson) return false;
  try {
    const cookies = JSON.parse(cookiesJson);
    if (Array.isArray(cookies) && cookies.length > 0) {
      await page.setCookie(...cookies);
      return true;
    }
  } catch (_) {}
  return false;
}

async function autoScroll(page, maxDurationMs) {
  const start = Date.now();
  while (Date.now() - start < maxDurationMs) {
    await page.evaluate(() => {
      window.scrollBy(0, window.innerHeight);
    });
    await sleep(1000);
  }
}

function sanitizeText(str) {
  return (str || '').replace(/\s+/g, ' ').trim();
}

async function extractPosts(page) {
  // Try different containers and attributes commonly seen in LinkedIn's feed
  return await page.evaluate(() => {
    function textContent(el) {
      return (el && el.textContent ? el.textContent : '').replace(/\s+/g, ' ').trim();
    }

    function getAttr(el, name) {
      return el && el.getAttribute ? el.getAttribute(name) : '';
    }

    const candidates = Array.from(document.querySelectorAll('[data-urn*="urn:li:activity:"], article'));

    const posts = [];
    for (const node of candidates) {
      try {
        // id and url
        const urn = node.getAttribute && node.getAttribute('data-urn');
        let id = '';
        let url = '';
        if (urn && urn.includes('urn:li:activity:')) {
          id = urn.split('urn:li:activity:')[1] || '';
          url = `https://www.linkedin.com/feed/update/urn:li:activity:${id}`;
        } else {
          const postLink = node.querySelector('a[href*="/feed/update/urn:li:activity:"]');
          if (postLink) {
            url = postLink.href;
            const m = url.match(/urn:li:activity:(\d+)/);
            if (m) id = m[1];
          }
        }

        // author
        const authorNameEl = node.querySelector('.update-components-actor__name, [data-test-id="actor-name"], a[href*="/company/"] span, a[href*="/in/"] span');
        const authorName = textContent(authorNameEl) || 'Dklinity';
        const avatarEl = node.querySelector('img.update-components-actor__avatar-image, img[alt*="logo" i], img[src*="profile"]');
        const authorAvatar = avatarEl ? (avatarEl.currentSrc || avatarEl.src || '') : '';

        // date
        const dateEl = node.querySelector('.update-components-actor__sub-description, time, span[datetime]');
        const date = textContent(dateEl);

        // text
        const textEl = node.querySelector('.update-components-text, div[dir="ltr"]');
        const text = textContent(textEl);

        // images (filter out tiny icons)
        const imageEls = Array.from(node.querySelectorAll('img'));
        const images = imageEls
          .map((img) => img.currentSrc || img.src || '')
          .filter((src) => src && !/data:image|sprite|transparent|gif|\/emoticons\//i.test(src))
          .filter((src) => !src.includes('data:image'));

        // link preview
        const linkEl = node.querySelector('a.app-aware-link[href^="http"]');
        const link = linkEl
          ? {
              url: linkEl.href,
              title: textContent(node.querySelector('span[dir="ltr"], h3, h4')) || linkEl.href,
              description: textContent(node.querySelector('p, span.break-words')),
              image: (node.querySelector('img[loading][src]') || {}).src || ''
            }
          : null;

        // counts (best effort)
        const likesText = textContent(node.querySelector('[data-test-id="social-actions__reactions-count"]')) || textContent(node.querySelector('.social-details-social-counts__reactions-count'));
        const commentsText = textContent(node.querySelector('[data-test-id="social-actions__comments-count"]')) || textContent(node.querySelector('a[data-control-name*="comments"]'));
        const repostsText = textContent(node.querySelector('[data-test-id="social-actions__reposts-count"]'));

        function parseCount(t) {
          if (!t) return 0;
          const m = t.match(/([\d,.]+)/);
          if (!m) return 0;
          return Number(m[1].replace(/,/g, '')) || 0;
        }

        const counts = {
          likes: parseCount(likesText),
          comments: parseCount(commentsText),
          reposts: parseCount(repostsText)
        };

        const post = {
          id,
          author: { name: authorName, avatar: authorAvatar },
          date,
          text,
          images: Array.from(new Set(images)),
          link,
          counts,
          url
        };

        // Require some minimum data (text or images) to consider it a post
        if (post.text || (post.images && post.images.length > 0)) {
          posts.push(post);
        }
      } catch (_) {
        // ignore post on failure
      }
    }

    return posts;
  });
}

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
  );
  await page.setViewport({ width: 1366, height: 900 });

  // Navigate home first to set cookies domain if provided
  await page.goto('https://www.linkedin.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  const cookiesSet = await setCookiesIfProvided(page);

  // Try to use the posts tab when possible
  const targetUrl = COMPANY_URL.endsWith('/') ? COMPANY_URL + 'posts/' : COMPANY_URL + '/posts/';
  await page.goto(targetUrl + '?viewAsMember=true', { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Attempt to close any gate/overlay
  try {
    await page.waitForSelector('button[aria-label*="Dismiss" i], button[aria-label*="Close" i]', { timeout: 5000 });
    await page.click('button[aria-label*="Dismiss" i], button[aria-label*="Close" i]');
    await sleep(1000);
  } catch (_) {}

  // Scroll to load posts
  await autoScroll(page, SCROLL_TIMEOUT_MS);

  // Extract and limit
  let posts = await extractPosts(page);
  if (Array.isArray(posts) && posts.length > MAX_POSTS) {
    posts = posts.slice(0, MAX_POSTS);
  }

  // Write output
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(posts, null, 2), 'utf-8');
  console.log(`Wrote ${posts.length} posts to ${OUTPUT_PATH}`);

  await browser.close();
})().catch((err) => {
  console.error('Failed to fetch LinkedIn posts:', err);
  process.exitCode = 1;
});

