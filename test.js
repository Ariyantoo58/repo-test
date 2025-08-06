const path = require('path');
const fs = require('fs');
const simpleGit = require('simple-git');
const { Configuration, OpenAIApi } = require('openai');
require('dotenv').config();

// ---------------------------------------------------------------------------
// OpenAI setup (optional – skip detection if key missing)
// ---------------------------------------------------------------------------
const openaiApiKey = process.env.OPENAI_API_KEY;
let openai = null;
if (openaiApiKey) {
  const configuration = new Configuration({ apiKey: openaiApiKey });
  openai = new OpenAIApi(configuration);
} else {
  console.warn(
    '[Mirror] OPENAI_API_KEY not provided – Indonesian comment detection disabled'
  );
}

// ---------------------------------------------------------------------------
// Configuration helpers
// ---------------------------------------------------------------------------
const LOCAL_REPOS_ROOT =
  process.env.LOCAL_REPOS_ROOT || path.join(__dirname, '..', '..', 'repos');

if (!fs.existsSync(LOCAL_REPOS_ROOT)) {
  fs.mkdirSync(LOCAL_REPOS_ROOT, { recursive: true });
}

// test ini code dari siniii

/**
 * Mirrors a repository that was just updated on Gitea to the client GitHub.
 * Additionally enforces policy: reject pushes introducing Indonesian comments.
 * @param {object} payload - Gitea webhook push event payload
 */
async function syncRepository(payload) {
  const repoName = payload?.repository?.name;
  const giteaCloneUrl = payload?.repository?.clone_url;

  if (!repoName || !giteaCloneUrl) {
    throw new Error('Repository information not found on payload');
  }

  const repoDir = path.join(LOCAL_REPOS_ROOT, repoName);
  const git = simpleGit();

  if (!fs.existsSync(repoDir)) {
    console.log(`[Mirror] Cloning new bare mirror for ${repoName}`);
    await git.clone(giteaCloneUrl, repoDir, ['--mirror']);
  }
  // tes ini saja yang ada

  const repoGit = simpleGit(repoDir);
  await repoGit.remote(['set-url', 'origin', giteaCloneUrl]);

  const rawClientPrefix = process.env.CLIENT_REMOTE_PREFIX;
  if (!rawClientPrefix) {
    throw new Error('CLIENT_REMOTE_PREFIX is not configured in environment');
  }
  let clientPrefix = rawClientPrefix.startsWith('git@github.com:')
    ? rawClientPrefix.replace(/^git@github\.com:/, 'https://github.com/')
    : rawClientPrefix;
  if (!clientPrefix.endsWith('/')) clientPrefix += '/';
  const clientRemoteUrl = `${clientPrefix}${repoName}.git`;
  await ensureRemote(repoGit, 'client', clientRemoteUrl);

  let originRefs = '';
  try {
    originRefs = await repoGit.listRemote(['--heads', 'origin']);
  } catch (_) {}
  if (!originRefs.trim()) {
    console.log(
      `[Mirror] Gitea repo ${repoName} is empty – seeding from client`
    );
    try {
      await repoGit.fetch('client');
      await repoGit.push(['--mirror', 'origin']);
    } catch (e) {
      console.warn(`[Mirror] Seed failed: ${e.message}`);
    }
  }

  await repoGit.fetch('origin');

  const hasIndonesian = await detectIndonesianComments(repoGit, payload);
  if (hasIndonesian) {
    const branchRef = payload?.ref || '';
    const branchName = branchRef.split('/').pop();
    console.warn(
      `[Mirror] Indonesian comments detected in push to ${repoName}. Rejecting by resetting branch ${branchName}.`
    );
    try {
      if (payload?.before && branchName) {
        await repoGit.push([
          '--force',
          'origin',
          `${payload.before}:refs/heads/${branchName}`,
        ]);
      }
    } catch (err) {
      console.error(
        '[Mirror] Failed to reset branch after policy violation:',
        err.message
      );
    }
    return;
  } else {
    console.log(`[Mirror] No Indonesian comments detected for ${repoName}`);
  }

  try {
    await repoGit.push(['--mirror', 'client']);
  } catch (err) {
    console.warn(`[Mirror] Push to client failedd: ${err.message}`);
  }
}

async function ensureRemote(repoGit, name, url) {
  const remotes = await repoGit.getRemotes(true);
  const existing = remotes.find((r) => r.name === name);
  if (!existing) return repoGit.addRemote(name, url);
  if (existing.refs?.fetch !== url)
    return repoGit.remote(['set-url', name, url]);
}

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------
async function detectIndonesianComments(repoGit, payload) {
  const before = payload?.before;
  const after = payload?.after;
  if (!before || !after) return false;

  console.log(
    `[Policy] Running Indonesian comment detection for range ${before}..${after}`
  );

  let diffText = '';
  try {
    diffText = await repoGit.diff([`${before}..${after}`]);
    console.log(`[Policy] Diff fetched (${diffText.length} chars)`);
  } catch (err) {
    console.warn('[Policy] Failed to diff:', err.message);
    return false;
  }

  const commentLines = diffText
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1).trim())
    .filter((line) => /^(\/\/|#|\*|\/\*)/.test(line));

  console.log('[Policy] Extracted comment lines:', commentLines);

  if (!commentLines.length) return false;

  const stopWords =
    /\b(yang|bisa|tidak|kita|kami|saya|anda|dengan|untuk|atau|pada|sebuah|adalah)\b/i;
  if (commentLines.some((l) => stopWords.test(l))) {
    console.log(
      '[Policy] Heuristic stop-word hit → Indonesian comment detected'
    );
    return true;
  }

  if (!openai) return false;

  const prompt = [
    'You are a language detector. Respond only with "true" if ANY of the following lines is written in Bahasa Indonesia, otherwise respond "false".',
    '',
    ...commentLines.map((l) => `- ${l}`),
  ].join('\n');

  try {
    const chat = await openai.createChatCompletion({
      model: 'gpt-3.5-turbo',
      temperature: 0,
      max_tokens: 1,
      messages: [
        { role: 'system', content: 'Respond only with "true" or "false".' },
        { role: 'user', content: prompt },
      ],
    });
    const answer = chat?.data?.choices?.[0]?.message?.content
      ?.trim()
      .toLowerCase();
    console.log('[Policy] OpenAI answer:', answer);
    return answer === 'true';
  } catch (err) {
    console.warn('[Policy] OpenAI call failed:', err.message);
    return false;
  }
}

module.exports = { syncRepository };
