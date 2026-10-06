import { SyncEngine } from '../shared/core.js';
import dotenv from 'dotenv';

// Load .env
dotenv.config();

/**
 * Main Entry Point for Node.js
 */
const STATUS_NAMES = { 1: 'Want to Read', 2: 'Currently Reading', 3: 'Read' };

async function main() {
    console.log("=== Kindle Sync (Node.js) ===");
    
    // 1. Get Config
    const RSS_URL = process.env.GOODREADS_RSS_URL;
    const CURRENTLY_READING_RSS_URL = process.env.GOODREADS_CURRENTLY_READING_RSS_URL;
    const HC_TOKEN = process.env.HARDCOVER_API_TOKEN;
    const DRY_RUN = process.env.DRY_RUN === 'true' || process.argv.includes('--dry-run');

    if (!RSS_URL || !HC_TOKEN) {
        console.error("❌ Stats: Missing Configuration. Please set GOODREADS_RSS_URL and HARDCOVER_API_TOKEN.");
        process.exit(1);
    }

    // Parse Limit
    const limitArgIndex = process.argv.indexOf('--limit');
    const LIMIT = limitArgIndex > -1 ? parseInt(process.argv[limitArgIndex + 1]) : 20;

    // Results per feed, for the summary
    const feeds = [];
    const combinedResults = { errors: [] };

    // 2. Sync Read Feed (status_id: 3)
    console.log("\n--- Syncing Read Books (status_id: 3) ---");
    const readEngine = new SyncEngine({
        hcToken: HC_TOKEN,
        rssUrl: RSS_URL,
        isDryRun: DRY_RUN,
        limit: LIMIT,
        statusId: 3,
        onLog: (msg, type) => {
            // We can colorize output here if we want terminal colors
            // For now, pure log is fine
            // console.log already handles it in the engine for debug, but we can customize
        }
    });

    try {
        const readResults = await readEngine.run();
        feeds.push({ statusId: 3, ...readResults });
        combinedResults.errors.push(...readResults.errors);
    } catch (e) {
        console.error("Critical Error syncing read feed:", e);
        combinedResults.errors.push(`Read feed sync failed: ${e.message}`);
    }

    // 3. Sync Currently-Reading Feed (status_id: 2) - Optional
    if (CURRENTLY_READING_RSS_URL) {
        console.log("\n--- Syncing Currently-Reading Books (status_id: 2) ---");
        const currentlyReadingEngine = new SyncEngine({
            hcToken: HC_TOKEN,
            rssUrl: CURRENTLY_READING_RSS_URL,
            isDryRun: DRY_RUN,
            limit: LIMIT,
            statusId: 2,
            onLog: (msg, type) => {
                // We can colorize output here if we want terminal colors
                // For now, pure log is fine
                // console.log already handles it in the engine for debug, but we can customize
            }
        });

        try {
            const currentlyReadingResults = await currentlyReadingEngine.run();
            feeds.push({ statusId: 2, ...currentlyReadingResults });
            combinedResults.errors.push(...currentlyReadingResults.errors);
        } catch (e) {
            console.error("Critical Error syncing currently-reading feed:", e);
            combinedResults.errors.push(`Currently-reading feed sync failed: ${e.message}`);
        }
    } else {
        console.log("\n--- Skipping Currently-Reading Feed (GOODREADS_CURRENTLY_READING_RSS_URL not set) ---");
    }

    // 4. Summary
    console.log("\n=== Sync Summary ===");
    if (DRY_RUN) console.log("DRY RUN: nothing was changed on Hardcover. Below is what would have happened.");
    for (const f of feeds) {
        const name = STATUS_NAMES[f.statusId];
        console.log(`\n${name} feed: ${f.added.length} added, ${f.updated.length} moved to ${name}, ${f.upToDate} already up to date` +
            (f.unmatched.length ? `, ${f.unmatched.length} not found on Hardcover` : '') +
            (f.errors.length ? `, ${f.errors.length} failed` : ''));
        f.added.forEach(b => console.log(` + Added as ${name}: ${b.title} (Hardcover ID: ${b.id})`));
        f.updated.forEach(b => console.log(` ~ Moved ${STATUS_NAMES[b.fromStatus] || `status ${b.fromStatus}`} -> ${name}: ${b.title} (Hardcover ID: ${b.id})`));
        f.unmatched.forEach(t => console.log(` ? Not found on Hardcover: ${t}`));
    }
    if(combinedResults.errors.length > 0) {
         console.log("\nErrors encountered:");
         combinedResults.errors.forEach(e => console.log(` - ${e}`));
         process.exit(1);
    }
    console.log("Done.");
}

main();
