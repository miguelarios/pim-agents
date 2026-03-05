/**
 * Parses structured search query strings into imapflow-compatible search criteria.
 *
 * Supported prefixes:
 * - from:address     → IMAP FROM filter
 * - to:address       → IMAP TO filter
 * - subject:text     → IMAP SUBJECT filter
 * - is:unread/read/flagged → flag filters
 * - has:attachment    → Content-Type header check
 * - since:YYYY-MM-DD → date range start
 * - before:YYYY-MM-DD → date range end
 * - plain text        → IMAP BODY search
 */
export function parseSearchQuery(query: string): Record<string, unknown> {
	const trimmed = query.trim();
	if (!trimmed) return {};

	const criteria: Record<string, unknown> = {};
	const plainParts: string[] = [];

	const tokens = trimmed.split(/\s+/);
	let i = 0;

	while (i < tokens.length) {
		const token = tokens[i];
		const colonIndex = token.indexOf(":");

		if (colonIndex > 0) {
			const prefix = token.substring(0, colonIndex).toLowerCase();
			const value = token.substring(colonIndex + 1);

			switch (prefix) {
				case "from":
					criteria.from = value;
					i++;
					break;
				case "to":
					criteria.to = value;
					i++;
					break;
				case "subject": {
					const subjectParts = [value];
					i++;
					while (i < tokens.length && !isPrefix(tokens[i])) {
						subjectParts.push(tokens[i]);
						i++;
					}
					criteria.subject = subjectParts.join(" ");
					break;
				}
				case "is":
					switch (value.toLowerCase()) {
						case "unread":
							criteria.seen = false;
							break;
						case "read":
							criteria.seen = true;
							break;
						case "flagged":
							criteria.flagged = true;
							break;
					}
					i++;
					break;
				case "has":
					if (value.toLowerCase() === "attachment") {
						criteria.header = { "content-type": "multipart/mixed" };
					}
					i++;
					break;
				case "since":
					criteria.since = new Date(value);
					i++;
					break;
				case "before":
					criteria.before = new Date(value);
					i++;
					break;
				default:
					plainParts.push(token);
					i++;
					break;
			}
		} else {
			plainParts.push(token);
			i++;
		}
	}

	if (plainParts.length > 0) {
		criteria.body = plainParts.join(" ");
	}

	return criteria;
}

const KNOWN_PREFIXES = new Set([
	"from",
	"to",
	"subject",
	"is",
	"has",
	"since",
	"before",
]);

function isPrefix(token: string): boolean {
	const colonIndex = token.indexOf(":");
	if (colonIndex <= 0) return false;
	return KNOWN_PREFIXES.has(token.substring(0, colonIndex).toLowerCase());
}
