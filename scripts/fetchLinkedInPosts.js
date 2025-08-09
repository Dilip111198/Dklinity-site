// scripts/fetchLinkedInPosts.js
// Node script to fetch LinkedIn company posts and write linkedin-feed.json
// Expects GitHub secrets mapped to env vars in the Action:
// LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET, LINKEDIN_ORG_URN
// Optionally: LINKEDIN_ACCESS_TOKEN (if you already have token)

const fs = require('fs');
const fetch = require('node-fetch'); // node-fetch v2

const CLIENT_ID = process.env.LINKEDIN_CLIENT_ID;
const CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET;
const ORG_URN = process.env.LINKEDIN_ORG_URN;
const MANUAL_TOKEN = process.env.LINKEDIN_ACCESS_TOKEN || null;

if (!ORG_URN) {
  console.error('Missing LINKEDIN_ORG_URN');
  process.exit(1);
}

async function getAccessTokenByClientCredentials() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('Missing client id/secret for token exchange');
  }
  const tokenUrl = 'https://www.linkedin.com/oauth/v2/accessToken';
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET
  });

  const res = await fetch(tokenUrl, {
    method: 'POST',
    body: body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token request failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  return data.access_token;
}

async function fetchPostsWithToken(token) {
  // Use ugcPosts to fetch posts authored by the organization
  const url = `https://api.linkedin.com/v2/ugcPosts?q=authors&authors=List(${encodeURIComponent(ORG_URN)})&sortBy=LAST_MODIFIED&count=50`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Restli-Protocol-Version': '2.0.0'
    }
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Fetch posts failed: ${res.status} ${txt}`);
  }
  return await res.json();
}

(async () => {
  try {
    let token = MANUAL_TOKEN;
    if (!token) {
      console.log('Attempting client_credentials token exchange...');
      try {
        token = await getAccessTokenByClientCredentials();
        console.log('Token obtained via client_credentials.');
      } catch (err) {
        console.warn('Client credentials token exchange failed:', err.message);
        console.warn('If this happens, create an OAuth access token with r_organization_social and store as LINKEDIN_ACCESS_TOKEN secret.');
        throw err; // bubble up to fail the job cleanly
      }
    }

    const posts = await fetchPostsWithToken(token);
    fs.writeFileSync('linkedin-feed.json', JSON.stringify(posts, null, 2), 'utf8');
    console.log('✅ Wrote linkedin-feed.json (posts fetched).');
  } catch (err) {
    console.error('❌ Error:', err.message || err);
    process.exit(2);
  }
})();
