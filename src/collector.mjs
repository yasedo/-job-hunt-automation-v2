const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const BASE_ID = process.env.AIRTABLE_BASE_ID || 'appzNZgfYlDQnSZqG';
const DRY_RUN = /^(1|true|yes)$/i.test(process.env.DRY_RUN || '');

if (!AIRTABLE_TOKEN) {
  console.error('Missing AIRTABLE_TOKEN GitHub Actions secret.');
  process.exit(2);
}

const TABLES = {
  jobs: 'Jobs',
  watchlist: 'Company Watchlist',
  runs: 'Collection Runs',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (v) => (v == null ? '' : String(v)).trim();
const lower = (v) => text(v).toLowerCase();
const selectName = (v) => (v && typeof v === 'object' ? text(v.name) : text(v));

function stripHtml(value) {
  return text(value)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeUrl(value) {
  try {
    const url = new URL(text(value));
    url.hash = '';
    for (const key of ['lever-source', 'utm_source', 'utm_medium', 'utm_campaign', 'gh_src', 'source']) {
      url.searchParams.delete(key);
    }
    return url.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return lower(value).replace(/\/$/, '');
  }
}

function dateOnly(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

async function fetchJson(url, options = {}, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'ysd-job-hunt-automation/1.0',
          ...(options.headers || {}),
        },
      });
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = Number(response.headers.get('retry-after') || 0);
        await sleep(retryAfter ? retryAfter * 1000 : attempt * 1000);
        continue;
      }
      if (!response.ok) throw new Error(`${response.status} ${response.statusText} — ${url}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(attempt * 750);
    }
  }
  throw lastError;
}

async function airtableRequest(table, { method = 'GET', params = {}, body } = {}) {
  const url = new URL(`https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(table)}`);
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, item);
    } else if (value != null) {
      url.searchParams.set(key, String(value));
    }
  }

  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${AIRTABLE_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (response.status === 429) {
      await sleep(350 * attempt);
      continue;
    }
    if (!response.ok) {
      const details = await response.text();
      lastError = new Error(`Airtable ${response.status}: ${details.slice(0, 1000)}`);
      if (response.status >= 500 && attempt < 5) {
        await sleep(700 * attempt);
        continue;
      }
      throw lastError;
    }
    await sleep(220);
    return response.status === 204 ? null : response.json();
  }
  throw lastError;
}

async function listAll(table, fields) {
  const records = [];
  let offset;
  do {
    const data = await airtableRequest(table, {
      params: {
        pageSize: 100,
        ...(fields?.length ? { 'fields[]': fields } : {}),
        ...(offset ? { offset } : {}),
      },
    });
    records.push(...(data.records || []));
    offset = data.offset;
  } while (offset);
  return records;
}

function chunks(array, size) {
  const result = [];
  for (let i = 0; i < array.length; i += size) result.push(array.slice(i, i + size));
  return result;
}

async function createRecords(table, fieldsList) {
  let count = 0;
  for (const batch of chunks(fieldsList, 10)) {
    if (!DRY_RUN) {
      await airtableRequest(table, {
        method: 'POST',
        body: { records: batch.map((fields) => ({ fields })), typecast: true },
      });
    }
    count += batch.length;
  }
  return count;
}

async function updateRecords(table, records) {
  let count = 0;
  for (const batch of chunks(records, 10)) {
    if (!DRY_RUN) {
      await airtableRequest(table, { method: 'PATCH', body: { records: batch, typecast: true } });
    }
    count += batch.length;
  }
  return count;
}

function roleFamilies(title, description = '') {
  const hay = lower(`${title} ${description}`);
  const out = [];
  const add = (name) => { if (!out.includes(name)) out.push(name); };
  if (/mechanic|manufactur|quality|process|production|automotive|mechatronic|industrial engineer|r&d|hardware|design engineer|test engineer|thermal|aerospace/.test(hay)) add('Engineering/Automotive');
  if (/operation|supply|logistic|procure|planning|business operation|strategy/.test(hay)) add('Operations');
  if (/sales|business development|account executive|\bbdr\b|\bsdr\b|commercial|partnership/.test(hay)) add('Sales/BDR');
  if (/marketing|social media|content|brand|communications|growth|community/.test(hay)) add('Marketing/Media');
  if (/customer|support|success|service/.test(hay)) add('Customer Success/Support');
  if (/product|project|program|\bpm\b/.test(hay)) add('Product/Project');
  if (/data|analytics|analyst|artificial intelligence|machine learning|\bai\b/.test(hay)) add('Data/AI');
  if (!out.length) add('Other');
  return out;
}

function employmentType(title, raw = '') {
  const hay = lower(`${title} ${raw}`);
  if (/working student/.test(hay)) return 'Working Student';
  if (/long[- ]?term.*intern|intern.*long[- ]?term/.test(hay)) return 'Long-term Internship';
  if (/intern|trainee|placement/.test(hay)) return 'Internship';
  if (/part[- ]?time/.test(hay)) return 'Part-time';
  if (/freelance/.test(hay)) return 'Freelance';
  if (/contract/.test(hay)) return 'Contract';
  if (/seasonal|temporary/.test(hay)) return 'Seasonal';
  return 'Full-time';
}

function workMode(location, raw = '') {
  const hay = lower(`${location} ${raw}`);
  if (/remote/.test(hay)) {
    if (/turkey|türkiye|istanbul/.test(hay)) return 'Remote Turkey';
    if (/emea|europe|\beu\b/.test(hay)) return 'Remote EMEA/Europe';
    if (/worldwide|global|anywhere/.test(hay)) return 'Remote Worldwide';
    return 'Remote';
  }
  if (/hybrid/.test(hay)) return /istanbul/.test(hay) ? 'Hybrid Istanbul' : 'Hybrid';
  if (/istanbul/.test(hay)) return 'On-site Istanbul';
  return 'Other';
}

function matchScore(job, employment, mode) {
  const title = lower(job.title);
  const location = lower(job.location);
  const description = lower(job.description);
  let score = 26;
  if (/turkey|türkiye|istanbul|kocaeli|gebze|bursa|ankara|izmir/.test(location)) score += 28;
  if (/remote/.test(lower(mode))) score += 18;
  if (/intern|working student|student|trainee|placement|graduate|new grad|entry|junior|assistant|associate|coordinator/.test(title)) score += 26;
  if (/mechanic|manufactur|quality|process|production|operation|product|project|marketing|customer|support|data|analytics|\bai\b|sales|business development/.test(title)) score += 13;
  if (/turkish|turkey|türkiye/.test(description)) score += 8;
  if (/senior|staff|principal|director|head of|vice president|\bvp\b/.test(title) && !/intern|student|trainee/.test(title)) score -= 30;
  if (/manager/.test(title) && !/intern|student|trainee|assistant/.test(title)) score -= 18;
  if (/cashier|store manager|warehouse picker|courier|driver/.test(title)) score -= 25;
  if (/united states|\busa\b|california|texas|new york|washington|virginia|massachusetts|georgia|colorado/.test(location) && !/remote|intern|student|graduate/.test(`${location} ${title}`)) score -= 12;
  if (employment === 'Full-time' && !/junior|entry|graduate|associate|assistant|coordinator/.test(title)) score -= 5;
  return Math.max(0, Math.min(100, score));
}

function eligibility(score) {
  if (score >= 76) return 'Eligible';
  if (score >= 56) return 'Probably Eligible';
  if (score >= 28) return 'Stretch';
  return 'Unknown';
}
function priority(score) {
  if (score >= 84) return 'P0 Apply Now';
  if (score >= 70) return 'P1 High';
  if (score >= 48) return 'P2 Medium';
  return 'P3 Low';
}
function scheduleFit(employment, mode) {
  const hay = lower(`${employment} ${mode}`);
  if (/part-time|working student|intern|remote/.test(hay)) return 'Green';
  if (/full-time|contract/.test(hay)) return 'Yellow';
  return 'Unknown';
}
function shouldKeep(job) {
  const hay = lower(`${job.title} ${job.location} ${job.description}`);
  return /turkey|türkiye|istanbul|remote|emea|europe|worldwide|global|intern|student|trainee|placement|graduate|junior|entry|assistant|associate|coordinator|mechanic|manufactur|quality|process|production|operation|product|project|marketing|customer|support|data|analytics|\bai\b|sales|business development/.test(hay);
}

async function collectLever(board) {
  const jobs = [];
  for (let skip = 0, page = 0; page < 30; page += 1, skip += 100) {
    const rows = await fetchJson(`https://api.lever.co/v0/postings/${encodeURIComponent(board)}?mode=json&skip=${skip}&limit=100`);
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const row of rows) jobs.push({
      id: text(row.id || row.hostedUrl || row.applyUrl), title: text(row.text),
      location: text(row.categories?.location || row.categories?.allLocations?.join(', ')),
      url: text(row.hostedUrl || row.applyUrl),
      description: stripHtml(row.descriptionPlain || row.description || `${row.descriptionBody || ''} ${row.additional || ''}`),
      posted: row.createdAt ? new Date(Number(row.createdAt)).toISOString() : null,
      employmentRaw: text(row.categories?.commitment), workplaceRaw: text(row.workplaceType), salary: '',
    });
    if (rows.length < 100) break;
  }
  return jobs;
}

async function collectGreenhouse(board) {
  const data = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs?content=true`);
  return (data.jobs || []).map((row) => ({
    id: text(row.id || row.absolute_url), title: text(row.title), location: text(row.location?.name),
    url: text(row.absolute_url), description: stripHtml(row.content), posted: row.updated_at || null,
    employmentRaw: '', workplaceRaw: '', salary: '',
  }));
}

async function collectAshby(board) {
  const data = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}?includeCompensation=true`);
  return (data.jobs || []).filter((row) => row.isListed !== false).map((row) => ({
    id: text(row.jobUrl || row.applyUrl || `${row.title}-${row.location}`), title: text(row.title),
    location: [text(row.location), ...(row.secondaryLocations || []).map((x) => text(x.location))].filter(Boolean).join(', '),
    url: text(row.jobUrl || row.applyUrl), description: text(row.descriptionPlain || stripHtml(row.descriptionHtml)),
    posted: row.publishedAt || null, employmentRaw: text(row.employmentType), workplaceRaw: text(row.workplaceType),
    salary: text(row.compensation?.compensationTierSummary || row.compensation?.scrapeableCompensationSalarySummary),
  }));
}

async function collectSmartRecruiters(board) {
  const jobs = [];
  for (let offset = 0, page = 0; page < 30; page += 1) {
    const data = await fetchJson(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(board)}/postings?limit=100&offset=${offset}&destination=PUBLIC`);
    const rows = data.content || [];
    for (const row of rows) {
      const loc = row.location || {};
      jobs.push({
        id: text(row.id || row.uuid), title: text(row.name),
        location: [loc.city, loc.region, loc.country].filter(Boolean).join(', '),
        url: text(row.ref || `https://jobs.smartrecruiters.com/${board}/${row.id}`), description: '',
        posted: row.releasedDate || null, employmentRaw: text(row.typeOfEmployment?.label || row.typeOfEmployment?.id),
        workplaceRaw: text(row.locationType || loc.remote), salary: '',
      });
    }
    offset += rows.length;
    if (!rows.length || offset >= Number(data.totalFound || rows.length) || rows.length < 100) break;
  }
  return jobs;
}

const collectors = { Lever: collectLever, Greenhouse: collectGreenhouse, Ashby: collectAshby, SmartRecruiters: collectSmartRecruiters };

async function main() {
  const startedAt = new Date();
  const nowIso = startedAt.toISOString();
  const today = nowIso.slice(0, 10);
  const runName = `ATS ${nowIso.replace(/[:.]/g, '-')}`;

  const watchRecords = await listAll(TABLES.watchlist, ['Company', 'ATS', 'Board ID', 'Active', 'Priority', 'Turkey Relevance']);
  const boards = watchRecords.map((record) => ({ id: record.id, ...record.fields }))
    .filter((row) => row.Active === true && collectors[selectName(row.ATS)] && text(row['Board ID']));

  const existingRecords = await listAll(TABLES.jobs, ['URL', 'Duplicate Key', 'Status']);
  const byDuplicate = new Map();
  const byUrl = new Map();
  for (const record of existingRecords) {
    const duplicate = lower(record.fields?.['Duplicate Key']);
    const url = normalizeUrl(record.fields?.URL);
    if (duplicate) byDuplicate.set(duplicate, record.id);
    if (url) byUrl.set(url, record.id);
  }

  let rawCount = 0, keptCount = 0, newCount = 0, updatedCount = 0;
  const errors = [], creates = [], updatesById = new Map();

  for (const boardRow of boards) {
    const company = text(boardRow.Company), ats = selectName(boardRow.ATS), board = text(boardRow['Board ID']);
    try {
      const jobs = await collectors[ats](board);
      rawCount += jobs.length;
      for (const job of jobs) {
        if (!job.title || !job.url || !shouldKeep(job)) continue;
        const employment = employmentType(job.title, job.employmentRaw);
        const mode = workMode(job.location, job.workplaceRaw);
        const score = matchScore(job, employment, mode);
        if (score < 18) continue;
        keptCount += 1;
        const duplicateKey = lower(`${ats}:${board}:${job.id || normalizeUrl(job.url)}`);
        const normalizedUrl = normalizeUrl(job.url);
        const existingId = byDuplicate.get(duplicateKey) || byUrl.get(normalizedUrl);
        const verification = `Open in public ${ats} feed; checked ${today}`;
        if (existingId) {
          updatesById.set(existingId, { id: existingId, fields: { 'Last Checked': nowIso, 'Posting Verification': verification } });
          continue;
        }
        const fields = {
          Job: `${company} — ${job.title}`.slice(0, 250), Company: company, Role: job.title, URL: job.url,
          Source: `${company} / ${ats}`, 'Source Type': 'ATS', Location: job.location || 'Unknown',
          'Work Mode': mode, 'Employment Type': employment, 'Role Family': roleFamilies(job.title, job.description),
          Eligibility: eligibility(score), 'Schedule Fit': scheduleFit(employment, mode), 'Match Score': score,
          Priority: priority(score), Status: 'Discovered',
          ...(dateOnly(job.posted) ? { 'Posted Date': dateOnly(job.posted) } : {}),
          ...(job.salary ? { 'Salary / Pay': job.salary.slice(0, 250) } : {}),
          'Application Method': 'Company ATS', 'AI / Automation Rule': 'Unknown', 'Last Checked': nowIso,
          'Duplicate Key': duplicateKey.slice(0, 500),
          Notes: [`Collected automatically from ${ats} board ${board}.`, job.description ? job.description.slice(0, 1800) : ''].filter(Boolean).join('\n\n'),
          'Next Action': 'Review role details, eligibility and application questions; customize CV if applying.',
          'Posting Verification': verification,
        };
        creates.push(fields);
        byDuplicate.set(duplicateKey, `pending-${creates.length}`);
        byUrl.set(normalizedUrl, `pending-${creates.length}`);
      }
    } catch (error) {
      const message = `${company} (${ats}/${board}): ${error.message || error}`;
      errors.push(message);
      console.error(message);
    }
  }

  newCount = await createRecords(TABLES.jobs, creates);
  updatedCount = await updateRecords(TABLES.jobs, [...updatesById.values()]);
  const resultText = errors.length ? `Partial success — ${errors.length} board error(s), ${updatedCount} refreshed` : `Success — ${updatedCount} refreshed`;
  const runFields = {
    Run: runName, Started: nowIso,
    'Source / Query': `Company Watchlist ATS collector: ${boards.length} active supported boards`,
    'Raw Count': rawCount, 'New Jobs': newCount,
    Result: DRY_RUN ? `DRY RUN — ${resultText}` : resultText,
    'Cursor / Next Batch': `Kept ${keptCount} potentially relevant openings. Duplicates suppressed by ATS/board/job key and normalized URL.`,
    'Errors / Notes': errors.length ? errors.join('\n') : 'No board-level errors.',
  };
  if (!DRY_RUN) await createRecords(TABLES.runs, [runFields]);
  else console.log(JSON.stringify(runFields, null, 2));

  console.log(JSON.stringify({ dryRun: DRY_RUN, boards: boards.length, rawCount, keptCount, newJobs: newCount, refreshedJobs: updatedCount, errors: errors.length }, null, 2));
  if (boards.length === 0) throw new Error('No active supported ATS boards found in Company Watchlist.');
  if (errors.length === boards.length) throw new Error('Every configured ATS board failed.');
}

main().catch((error) => { console.error(error); process.exit(1); });
