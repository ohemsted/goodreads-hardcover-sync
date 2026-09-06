import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Removes the duplicate read entries left behind by the pre-fix sync.
 *
 * Inserting a user_book with the Read status makes Hardcover create a read
 * entry, and the sync then inserted a second one carrying the Goodreads date.
 * Every book synced that way ended up with two reads, which reading stats then
 * report as a re-read.
 *
 * Dry run by default: it prints what it would remove and changes nothing until
 * you pass --apply.
 *
 *   node scripts/dedupe-reads.js                    # report on 2026
 *   node scripts/dedupe-reads.js --year 2025        # a different year
 *   node scripts/dedupe-reads.js --all-years        # every year at once
 *   node scripts/dedupe-reads.js --keep latest      # keep the newest date
 *   node scripts/dedupe-reads.js --apply            # actually delete
 */

const ENDPOINT = 'https://api.hardcover.app/v1/graphql';
const PAGE_SIZE = 100;
const DELETE_DELAY_MS = 400;

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i > -1 && args[i + 1] ? args[i + 1] : fallback;
};

const APPLY = flag('apply');
const ALL_YEARS = flag('all-years');
const YEAR = Number(value('year', '2026'));
const KEEP = value('keep', 'earliest');

if (!['earliest', 'latest'].includes(KEEP)) {
    console.error(`❌ --keep must be 'earliest' or 'latest', got '${KEEP}'`);
    process.exit(1);
}
if (!ALL_YEARS && !Number.isInteger(YEAR)) {
    console.error(`❌ --year must be a whole number, got '${value('year', '')}'`);
    process.exit(1);
}

const TOKEN = process.env.HARDCOVER_API_TOKEN;
if (!TOKEN) {
    console.error('❌ Missing HARDCOVER_API_TOKEN. Set it in .env or the environment.');
    process.exit(1);
}

async function graphql(query, variables = {}, retries = 3) {
    const auth = TOKEN.startsWith('Bearer ') ? TOKEN : `Bearer ${TOKEN}`;
    const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({ query, variables }),
    });

    if (res.status === 429 && retries > 0) {
        console.log('   [API] Throttled. Waiting 3s...');
        await new Promise((r) => setTimeout(r, 3000));
        return graphql(query, variables, retries - 1);
    }
    if (!res.ok) throw new Error(`API Error ${res.status}: ${await res.text()}`);

    const json = await res.json();
    if (json.errors) throw new Error('GraphQL Error: ' + JSON.stringify(json.errors));
    return json.data;
}

const READS_QUERY = `
  query MyReads($limit: Int!, $offset: Int!) {
    me {
      user_books(
        where: { status_id: { _eq: 3 } }
        order_by: { id: asc }
        limit: $limit
        offset: $offset
      ) {
        id
        book { title }
        user_book_reads(order_by: { id: asc }) {
          id
          started_at
          finished_at
        }
      }
    }
  }
`;

async function fetchReadShelf() {
    const books = [];
    for (;;) {
        const data = await graphql(READS_QUERY, { limit: PAGE_SIZE, offset: books.length });
        const page = data?.me?.[0]?.user_books ?? data?.me?.user_books ?? [];
        books.push(...page);
        if (page.length < PAGE_SIZE) break;
    }
    return books;
}

const yearOf = (date) => (date ? Number(String(date).slice(0, 4)) : null);

/**
 * Finds books carrying more than one read in the same year. Reads are only ever
 * compared within a year, so a book genuinely read again in a later year keeps
 * both of its entries.
 */
function findDuplicates(books) {
    const findings = [];

    for (const userBook of books) {
        const byYear = new Map();
        for (const read of userBook.user_book_reads) {
            const year = yearOf(read.finished_at);
            if (year === null) continue;
            if (!ALL_YEARS && year !== YEAR) continue;
            const bucket = byYear.get(year);
            if (bucket) bucket.push(read);
            else byYear.set(year, [read]);
        }

        for (const [year, reads] of byYear) {
            if (reads.length < 2) continue;

            // ISO dates sort lexicographically; id breaks ties so the entry
            // Hardcover created first is the one kept under 'earliest'.
            const sorted = [...reads].sort(
                (a, b) => a.finished_at.localeCompare(b.finished_at) || a.id - b.id,
            );
            const keep = KEEP === 'latest' ? sorted[sorted.length - 1] : sorted[0];

            findings.push({
                title: userBook.book?.title ?? `user_book ${userBook.id}`,
                userBookId: userBook.id,
                year,
                keep,
                remove: sorted.filter((read) => read.id !== keep.id),
            });
        }
    }

    return findings;
}

const describe = (read) =>
    `#${read.id} finished ${read.finished_at}${read.started_at ? ` (started ${read.started_at})` : ''}`;

async function main() {
    const scope = ALL_YEARS ? 'all years' : YEAR;
    console.log(`=== Duplicate read cleanup (${scope}) ===`);
    console.log(APPLY ? 'Mode: APPLY — entries will be deleted\n' : 'Mode: DRY RUN — nothing will be changed\n');

    const books = await fetchReadShelf();
    console.log(`Read shelf: ${books.length} books\n`);

    const findings = findDuplicates(books);
    if (findings.length === 0) {
        console.log('✅ No duplicate reads found. Nothing to do.');
        return;
    }

    for (const finding of findings) {
        console.log(`${finding.title} (${finding.year})`);
        console.log(`   keep   ${describe(finding.keep)}`);
        for (const read of finding.remove) console.log(`   remove ${describe(read)}`);
    }

    const doomed = findings.flatMap((finding) => finding.remove);
    console.log(`\n${findings.length} book/year pairs affected, ${doomed.length} entries to remove.`);

    if (!APPLY) {
        console.log('\nRe-run with --apply to delete them.');
        return;
    }

    // Deletion can't be undone through the API, so keep a record of exactly what
    // was removed — enough to re-insert by hand if a judgement call was wrong.
    const backup = `dedupe-reads-backup-${Date.now()}.json`;
    fs.writeFileSync(backup, JSON.stringify(findings, null, 2));
    console.log(`\nBackup written to ${backup}`);

    const DELETE = `mutation DeleteRead($id: Int!) { delete_user_book_read(id: $id) { id } }`;
    let removed = 0;
    const failures = [];

    for (const read of doomed) {
        try {
            await graphql(DELETE, { id: read.id });
            removed++;
            console.log(`   ✅ deleted #${read.id}`);
        } catch (e) {
            failures.push(`#${read.id}: ${e.message}`);
            console.log(`   ❌ failed #${read.id}: ${e.message}`);
        }
        await new Promise((r) => setTimeout(r, DELETE_DELAY_MS));
    }

    console.log(`\n=== Done: ${removed} removed, ${failures.length} failed ===`);
    if (failures.length > 0) process.exit(1);
}

main().catch((e) => {
    console.error('Critical error:', e.message);
    process.exit(1);
});
