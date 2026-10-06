/**
 * Shared Core Logic for Kindle Sync
 * Used by both Chrome Extension and Node.js Script
 */

// Minimal HTML entity decoder for common entities seen in RSS feeds
const decodeHtmlEntities = (str) => {
    if (!str || typeof str !== 'string') return str;
    
    const named = {
        '&amp;': '&',
        '&quot;': '"',
        '&#39;': '\'',
        '&apos;': '\'',
        '&lt;': '<',
        '&gt;': '>'
    };

    return str
        .replace(/&(?:amp|quot|#39|apos|lt|gt);/g, (m) => named[m] || m)
        .replace(/&#(\d+);/g, (_, code) => {
            const num = parseInt(code, 10);
            return Number.isNaN(num) ? _ : String.fromCharCode(num);
        })
        .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => {
            const num = parseInt(code, 16);
            return Number.isNaN(num) ? _ : String.fromCharCode(num);
        });
};

export const Utils = {
    // Port of thefuzz's token_sort_ratio basic approximation or standard levenshtein
    tokenSortRatio: (str1, str2) => {
        if (!str1 || !str2) return 0;
        
        // 1. Tokenize & Sort
        const s1 = str1.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).sort().join(" ");
        const s2 = str2.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).sort().join(" ");
        
        if (s1 === s2) return 100;
        
        // 2. Levenshtein
        const lev = Utils.levenshtein(s1, s2);
        const maxLen = Math.max(s1.length, s2.length);
        
        return Math.floor((1 - lev / maxLen) * 100);
    },

    levenshtein: (a, b) => {
        if (a.length === 0) return b.length;
        if (b.length === 0) return a.length;
        
        const matrix = [];
        for (let i = 0; i <= b.length; i++) matrix[i] = [i];
        for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
        
        for (let i = 1; i <= b.length; i++) {
            for (let j = 1; j <= a.length; j++) {
                if (b.charAt(i - 1) === a.charAt(j - 1)) {
                    matrix[i][j] = matrix[i - 1][j - 1];
                } else {
                    matrix[i][j] = Math.min(
                        matrix[i - 1][j - 1] + 1, // substitution
                        Math.min(
                            matrix[i][j - 1] + 1, // insertion
                            matrix[i - 1][j] + 1  // deletion
                        )
                    );
                }
            }
        }
        return matrix[b.length][a.length];
    },

    // XML Parser (Regex based for cross-platform compatibility)
    parseRSS: (xmlText) => {
        const entries = [];
        const itemRegex = /<item>([\s\S]*?)<\/item>/g;
        let itemMatch;
        
        while ((itemMatch = itemRegex.exec(xmlText)) !== null) {
            const itemContent = itemMatch[1];
            
            const getTag = (tag) => {
                const tagRegex = new RegExp(`<${tag}.*?>([\\s\\S]*?)<\/${tag}>`);
                const match = tagRegex.exec(itemContent);
                if (!match) return null;
                const raw = match[1].replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim();
                return decodeHtmlEntities(raw);
            };

            entries.push({
                title: getTag("title"),
                author_name: getTag("author_name"),
                isbn: getTag("isbn"),
                isbn13: getTag("isbn13"),
                user_rating: getTag("user_rating"),
                user_read_at: getTag("user_read_at"),
                user_date_added: getTag("user_date_added"),
                book_id: getTag("book_id")
            });
        }
        return entries;
    }
};

export class SyncEngine {
    constructor({ hcToken, rssUrl, isDryRun = false, limit = 20, statusId = 3, onLog = () => {} }) {
        this.hcToken = hcToken;
        this.rssUrl = rssUrl;
        this.isDryRun = isDryRun;
        this.limit = limit;
        this.statusId = statusId;
        this.onLog = onLog;
        this.hcEndpoint = "https://api.hardcover.app/v1/graphql";
        this.results = {
            newBooks: 0,
            added: [],      // { title, id } newly added with this feed's status
            updated: [],    // { title, id, fromStatus, toStatus } moved from another status
            upToDate: 0,    // already in the library with this feed's status
            unmatched: [],  // titles not found on Hardcover
            errors: []
        };
    }

    log(msg, type = 'info') {
        this.onLog(msg, type);
        // Console fallback is managed by the caller usually, but helpful for debugging
        if (type === 'error') console.error(msg);
        else console.log(msg);
    }

    async run() {
        try {
            if (!this.hcToken || !this.rssUrl) {
                this.log("Missing credentials.", "error");
                return this.results;
            }

            // 1. Fetch RSS
            this.log("Fetching RSS Feed...", "info");
            const res = await fetch(this.rssUrl);
            const text = await res.text();
            const entries = Utils.parseRSS(text);
            
            if (entries.length === 0) {
                this.log("No entries found in RSS.", "warn");
                return this.results;
            }

            // 2. Fetch Library
            this.log("Fetching Hardcover Library...", "info");
            const { bookIds, bookIdToUserBook, existingIsbns, existingTitles } = await this.getHardcoverLibraryIds();
            this.log(`Library loaded. ${bookIds.size} books.`, "info");

            // 3. Compare
            // Use configured limit or default to 20. If 0, use all.
            const limitVal = (this.limit === 0) ? entries.length : (this.limit || 20);
            const processList = entries.slice(0, limitVal).reverse();
            
            this.log(`Processing ${processList.length} recent books... (Limit: ${this.limit === 0 ? 'ALL' : limitVal})`, "info");

            for (const entry of processList) {
                // --- A. API Verification ---
                this.log(`[Candidate] '${entry.title}' - Verifying...`, 'info');
                
                let candidateIds = [];
                const libraryBookId = this.findLibraryBookId(entry, existingIsbns, existingTitles);
                if (libraryBookId) {
                    this.log(`[Library Match] '${entry.title}' already in library (ID: ${libraryBookId})`, 'debug');
                    candidateIds = [libraryBookId];
                } else {
                    try {
                        candidateIds = await this.searchHardcoverBookIds(entry.title, entry.author_name, entry.isbn13 || entry.isbn);
                    } catch (e) {
                        this.log(`Search failed for ${entry.title}: ${e.message}`, 'error');
                    }
                }

                let bookId = candidateIds[0] ?? null;
                if (!bookId) {
                    this.log(`[No Match] Could not find '${entry.title}' in Hardcover.`, 'warn');
                    this.results.unmatched.push(entry.title);
                    // We DO NOT count unmatchable books as newBooks, same as extension fix
                    continue;
                }

                // --- C. Existing Book? Update instead of insert ---
                const libraryCandidate = candidateIds.find(id => bookIdToUserBook.has(id));
                if (libraryCandidate) {
                    await this.updateExistingStatus(entry, libraryCandidate, bookIdToUserBook);
                    continue;
                }

                // --- D. New Book: Insert ---
                this.log(`[Verified New] '${entry.title}' (ID: ${bookId})`, 'success');

                if (this.isDryRun) {
                    this.results.newBooks++;
                    this.results.added.push({ title: entry.title, id: bookId });
                    continue;
                }

                // REAL RUN
                try {
                    const added = await this.addFirstAvailableBook(candidateIds, entry, bookIdToUserBook);
                    if (added.inLibrary) {
                        await this.updateExistingStatus(entry, added.bookId, bookIdToUserBook);
                        continue;
                    }
                    const userBookId = added.userBookId;
                    if (userBookId) {
                        bookId = added.bookId;
                        bookIds.add(bookId);
                        this.results.newBooks++;
                        this.results.added.push({ title: entry.title, id: bookId });
                        this.log(`✅ Added: ${entry.title}`, 'success');

                        // A finish date is what makes Hardcover treat a book as read, so
                        // only finished books get one.
                        const rawDate = entry.user_read_at || entry.user_date_added;
                        if (this.statusId !== 3) {
                            this.log(`Status ${this.statusId}: not setting a read date`, 'debug');
                        } else if (rawDate) {
                            this.log(`Received Date: '${rawDate}' (Source: ${entry.user_read_at ? 'Read At' : 'Date Added'})`, 'debug');
                            const dateStr = this.parseReadDate(rawDate);
                            if (dateStr) {
                                this.log(`Adding Read Date: ${dateStr}`, 'info');
                                await this.setReadDate(userBookId, dateStr);
                            } else this.log(`Could not parse date: '${rawDate}'`, 'warn');
                        } else this.log(`No date found for '${entry.title}' (read_at and date_added both empty)`, 'warn');
                    } else {
                        this.log(`❌ Failed to add: ${entry.title}`, 'error');
                        this.results.errors.push(entry.title);
                    }
                } catch (e) {
                    this.log(`❌ Error adding '${entry.title}': ${e.message}`, 'error');
                    this.results.errors.push(`${entry.title} (${e.message})`);
                }

                // Rate Limit
                await new Promise(r => setTimeout(r, 2000));
            }

            return this.results;

        } catch (e) {
            this.log(`Sync Critical Error: ${e.message}`, 'error');
            throw e;
        }
    }

    // --- API Helpers ---

    async graphqlQuery(query, variables, retries = 3) {
        const authHeader = this.hcToken.startsWith("Bearer ") ? this.hcToken : `Bearer ${this.hcToken}`;
        
        try {
            const res = await fetch(this.hcEndpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
                body: JSON.stringify({ query, variables })
            });

            if (res.status === 429) {
                if (retries > 0) {
                    this.log(`[API] Throttled. Waiting 3s...`, 'warn');
                    await new Promise(r => setTimeout(r, 3000));
                    return this.graphqlQuery(query, variables, retries - 1);
                } else {
                    throw new Error("429 Throttled (Max Retries)");
                }
            }

            if (!res.ok) {
                const text = await res.text();
                throw new Error(`API Error ${res.status}: ${res.statusText} | ${text}`);
            }

            const json = await res.json();
            if (json.errors) {
                throw new Error("GraphQL Error: " + JSON.stringify(json.errors));
            }
            return json;

        } catch (e) {
            if (retries > 0 && e.message.includes("Failed to fetch")) {
                this.log(`Network Error. Retry...`, 'warn');
                await new Promise(r => setTimeout(r, 2000));
                return this.graphqlQuery(query, variables, retries - 1);
            }
            throw e;
        }
    }

    // Brings a book already in the library to this feed's status. The status change is
    // done by deleting and re-adding the user_book, which also drops its read entries.
    async updateExistingStatus(entry, bookId, bookIdToUserBook) {
        const existing = bookIdToUserBook.get(bookId);
        if (existing.statusId === this.statusId) {
            this.log(`[Skip] '${entry.title}' (already status ${this.statusId})`, 'debug');
            this.results.upToDate++;
            return;
        }
        this.log(`[Update] '${entry.title}' (ID: ${bookId}) - status ${existing.statusId} -> ${this.statusId}`, 'info');
        const change = { title: entry.title, id: bookId, fromStatus: existing.statusId, toStatus: this.statusId };
        if (this.isDryRun) {
            this.results.updated.push(change);
            return;
        }
        try {
            const oldReads = await this.getReads(existing.userBookId);
            if (oldReads.length) this.log(`Removing ${oldReads.length} read entr${oldReads.length === 1 ? 'y' : 'ies'} with the old status: ${JSON.stringify(oldReads)}`, 'info');
            await this.deleteUserBook(existing.userBookId);
            const { userBookId } = await this.addBookToHardcover(bookId, entry.user_rating, entry.user_read_at);
            if (userBookId) {
                bookIdToUserBook.set(bookId, { userBookId, statusId: this.statusId });
                this.results.updated.push(change);
                this.log(`✅ Updated: ${entry.title}`, 'success');
                if (this.statusId === 3) {
                    const rawDate = entry.user_read_at || entry.user_date_added;
                    if (rawDate) {
                        const dateStr = this.parseReadDate(rawDate);
                        if (dateStr) {
                            this.log(`Adding Read Date: ${dateStr}`, 'info');
                            await this.setReadDate(userBookId, dateStr);
                        }
                    }
                }
                this.log(`Read entries now: ${JSON.stringify(await this.getReads(userBookId))}`, 'info');
            } else {
                this.log(`❌ Failed to re-add: ${entry.title}`, 'error');
                this.results.errors.push(entry.title);
            }
        } catch (e) {
            this.log(`❌ Error updating '${entry.title}': ${e.message}`, 'error');
            this.results.errors.push(`${entry.title} (${e.message})`);
        }
        await new Promise(r => setTimeout(r, 2000));
    }

    async getHardcoverLibraryIds() {
        // Include status_id 1 (want to read), 2 (currently-reading), 3 (read) so we can update existing rows
        const query = `query GetMyBooks { me { user_books(where: {status_id: {_in: [1, 2, 3]}}) { id status_id book { id title contributions { author { name } } editions { isbn_10 isbn_13 } } } } }`;
        const res = await this.graphqlQuery(query);
        const bookIds = new Set();
        const bookIdToUserBook = new Map(); // book_id -> { userBookId, statusId } for updates
        const existingIsbns = new Map(); // isbn -> book_id
        const existingTitles = new Map(); // lowercased title (and short title) -> [{ bookId, authors, exact }]

        const userBooks = res.data.me?.[0]?.user_books || [];
        userBooks.forEach(ub => {
            bookIds.add(ub.book.id);
            bookIdToUserBook.set(ub.book.id, { userBookId: ub.id, statusId: ub.status_id });
            const authors = (ub.book.contributions || []).map(c => c.author?.name).filter(n => n);
            this.titleVariants(ub.book.title).forEach((t, i) => {
                if (!existingTitles.has(t)) existingTitles.set(t, []);
                existingTitles.get(t).push({ bookId: ub.book.id, authors, exact: i === 0 });
            });
            if (ub.book.editions) ub.book.editions.forEach(ed => {
                if (ed.isbn_10) existingIsbns.set(ed.isbn_10, ub.book.id);
                if (ed.isbn_13) existingIsbns.set(ed.isbn_13, ub.book.id);
            });
        });
        return { bookIds, bookIdToUserBook, existingIsbns, existingTitles };
    }

    async searchHardcoverBookIds(title, author, isbn) {
        const candidates = {};
        
        const searchAndVerify = async (searchTitle, sourceLabel) => {
            const query = `query SearchBooks($title: String!) { books(where: {title: {_eq: $title}}, limit: 50, order_by: {users_count: desc}) { id title users_count contributions { author { name } } } }`;
            const res = await this.graphqlQuery(query, { title: searchTitle });
            (res.data.books || []).forEach(bk => {
                 let authors = (bk.contributions || []).map(c => c.author?.name).filter(n => n);
                 if (authors.some(ba => Utils.tokenSortRatio(author, ba) > 70)) {
                     if (!candidates[bk.id]) candidates[bk.id] = { ...bk, match_source: sourceLabel };
                 }
            });
        };

        if (isbn) {
             const query = `query SearchByISBN($isbn:String!) { editions(where: {_or: [{isbn_10: {_eq: $isbn}}, {isbn_13: {_eq: $isbn}}]}) { book { id title users_count } } }`;
             const res = await this.graphqlQuery(query, { isbn });
             (res.data.editions || []).forEach(ed => {
                 if (ed.book && !candidates[ed.book.id]) candidates[ed.book.id] = { ...ed.book, match_source: 'ISBN' };
             });
        }

        await searchAndVerify(title.trim(), "FullTitle");
        const separators = [':', '(', '-'];
        for (const sep of separators) {
            if (title.includes(sep)) {
                const short = title.split(sep)[0].trim();
                // Ensure sufficient length for short title search
                if (short.length >= 4) await searchAndVerify(short, `ShortTitle(${sep})`);
            }
        }

        // Ranked best-first, so callers can fall back when Hardcover rejects the top match
        return Object.values(candidates)
            .sort((a, b) => (b.users_count || 0) - (a.users_count || 0))
            .map(c => c.id);
    }

    // Book already in the library under a different ID (e.g. the search's top match is a
    // dead duplicate but the user added the live record by hand)?
    findLibraryBookId(entry, existingIsbns, existingTitles) {
        for (const isbn of [entry.isbn13, entry.isbn]) {
            if (isbn && existingIsbns.has(isbn)) return existingIsbns.get(isbn);
        }
        // An exact full-title match is trusted as before. A match that relies on a short
        // title on either side ("Dune" vs "Dune: Messiah") also needs the author to agree.
        const variants = this.titleVariants(entry.title);
        const exact = (existingTitles.get(variants[0]) || []).find(m => m.exact);
        if (exact) return exact.bookId;
        for (const t of variants) {
            const match = (existingTitles.get(t) || [])
                .find(m => m.authors.some(a => Utils.tokenSortRatio(entry.author_name || '', a) > 70));
            if (match) return match.bookId;
        }
        return null;
    }

    // Lowercased full title plus the part before ':' or '('. Goodreads and Hardcover often
    // disagree on subtitles, so both the library and the feed are matched on these.
    titleVariants(rawTitle) {
        const title = rawTitle.trim().toLowerCase();
        const shorts = [':', '('].filter(sep => title.includes(sep))
            .map(sep => title.split(sep)[0].trim()).filter(t => t.length >= 4);
        return [title, ...shorts];
    }

    // Inserts the first candidate Hardcover accepts. Moves past records Hardcover reports
    // as missing ("Was it deleted?"); any other failure stops the attempt.
    // If every candidate is missing, retries with Hardcover's full-text search, which finds
    // the live record when its title differs from the dead one's.
    async addFirstAvailableBook(candidateIds, entry, bookIdToUserBook = new Map()) {
        const tried = new Set();
        const tryAll = async (ids) => {
            for (const bookId of ids) {
                if (tried.has(bookId)) continue;
                tried.add(bookId);
                if (bookIdToUserBook.has(bookId)) return { bookId, userBookId: null, allMissing: false, inLibrary: true };
                const { userBookId, missing } = await this.addBookToHardcover(bookId, entry.user_rating, entry.user_read_at);
                if (userBookId) return { bookId, userBookId, allMissing: false };
                if (!missing) return { bookId: null, userBookId: null, allMissing: false };
                this.log(`Book ID ${bookId} is missing on Hardcover, trying next match...`, 'warn');
            }
            return { bookId: null, userBookId: null, allMissing: true };
        };

        const result = await tryAll(candidateIds);
        if (!result.allMissing) return result;

        let fallbackIds = [];
        try {
            fallbackIds = await this.fullTextSearchBookIds(entry.title, entry.author_name);
        } catch (e) {
            this.log(`Full-text search failed for ${entry.title}: ${e.message}`, 'error');
        }
        this.log(`[Fallback] Full-text search found ${fallbackIds.length} match(es) for '${entry.title}'`, 'info');
        return tryAll(fallbackIds);
    }

    async fullTextSearchBookIds(title, author) {
        const query = `query FullTextSearch($query: String!) { search(query: $query, query_type: "Book", per_page: 10) { results } }`;
        const short = title.split(':')[0].trim();
        const res = await this.graphqlQuery(query, { query: `${short} ${author || ''}`.trim() });
        let results = res.data.search?.results;
        if (typeof results === 'string') results = JSON.parse(results);
        return (results?.hits || [])
            .map(h => h.document || {})
            .filter(d => (d.author_names || []).some(a => Utils.tokenSortRatio(author, a) > 70))
            .map(d => parseInt(d.id, 10))
            .filter(id => !Number.isNaN(id));
    }

    parseReadDate(rawDate) {
        if (!rawDate) return null;
        const match = rawDate.match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/);
        if (match) {
            const [_, day, monthStr, year] = match;
            const months = {Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12'};
            const month = months[monthStr];
            if (month) return `${year}-${month}-${day.padStart(2, '0')}`;
        }
        const d = new Date(rawDate);
        return !isNaN(d) ? d.toISOString().split('T')[0] : null;
    }

    normalizeRating(rating) {
        const n = rating ? parseInt(rating, 10) : null;
        return (n >= 1 && n <= 5) ? n : null;
    }

    async deleteUserBook(userBookId) {
        const mutation = `mutation DeleteUserBook($id: Int!) { delete_user_book(id: $id) { id } }`;
        await this.graphqlQuery(mutation, { id: userBookId });
    }

    async addBookToHardcover(bookId, rating, readAt) {
        const mutation = `mutation AddUserBook($book_id: Int!, $status_id: Int!, $rating: numeric) { insert_user_book(object: { book_id: $book_id, status_id: $status_id, rating: $rating }) { id error } }`;
        const res = await this.graphqlQuery(mutation, { book_id: bookId, status_id: this.statusId, rating: this.normalizeRating(rating) });
        
        const data = res.data.insert_user_book;
        if (data && data.error) {
             if (data.error.includes("Uniqueness violation")) {
                 this.log(`[Duplicate] Book ID ${bookId} already in library (API).`, 'warn');
             } else {
                 this.log(`[API Error] Failed to add book ${bookId}: ${data.error}`, 'error');
             }
             return { userBookId: null, missing: /weren't able to find that book/i.test(data.error) };
        }
        
        return { userBookId: data?.id, missing: false };
    }

    async getReads(userBookId) {
        const query = `query ExistingReads($user_book_id: Int!) { user_book_reads(where: {user_book_id: {_eq: $user_book_id}}, order_by: {id: asc}) { id started_at finished_at } }`;
        const res = await this.graphqlQuery(query, { user_book_id: userBookId });
        return res?.data?.user_book_reads || [];
    }

    /**
     * Records the finish date for a book.
     *
     * Hardcover creates a read entry of its own when a user_book is inserted
     * with the Read status, so inserting a second one here left every synced
     * book with two reads — which anything reading the history back reports as
     * a re-read. Fill in the entry Hardcover already made, and only insert when
     * there genuinely isn't one.
     */
    async setReadDate(userBookId, finishedAt) {
        const existing = await this.getReads(userBookId);

        if (existing.length === 0) {
            const mutation = `mutation AddReadDate($user_book_id: Int!, $finished_at: date) { insert_user_book_read(user_book_id: $user_book_id, user_book_read: {finished_at: $finished_at}) { id } }`;
            await this.graphqlQuery(mutation, { user_book_id: userBookId, finished_at: finishedAt });
            return;
        }

        // The oldest entry is the one created alongside the user_book. Updating
        // it keeps whatever started_at Hardcover recorded with it.
        const mutation = `mutation SetReadDate($id: Int!, $finished_at: date) { update_user_book_read(id: $id, object: {finished_at: $finished_at}) { id } }`;
        await this.graphqlQuery(mutation, { id: existing[0].id, finished_at: finishedAt });
    }
}
