/**
 * Tool descriptions and argument help text. These strings are part of the
 * model-facing contract, and most began as the LibreChat wording Luma replaces —
 * kept because the citation anchors downstream of them are parsed by shape. Kept
 * is not sacred: where the inherited wording produced the wrong behaviour it has
 * been rewritten, and the reason is recorded next to it.
 */

export const INTENT_DESCRIPTION =
  'ALWAYS write this field FIRST, before any other argument. One present-progressive sentence saying what THIS call is about to do: "Searching for OAuth handling in the callback router". Shown to the user as this call\'s live status. Never name the tool. Sibling calls to one tool must differ.';

export const QUERY_DESCRIPTION = `GUIDELINES:
- Start broad, then narrow: Begin with key concepts, then refine with specifics
- Think like sources: Use terminology experts would use in the field
- Consider perspective: Frame queries from different viewpoints for better results
- Quality over quantity: A precise 3-4 word query often beats lengthy sentences

TECHNIQUES (combine for power searches):
- EXACT PHRASES: Use quotes ("climate change report")
- EXCLUDE TERMS: Use minus to remove unwanted results (-wikipedia)
- SITE-SPECIFIC: Restrict to websites (site:edu research)
- FILETYPE: Find specific documents (filetype:pdf study)
- OR OPERATOR: Find alternatives (electric OR hybrid cars)
- DATE RANGE: Recent information (data after:2020)
- WILDCARDS: Use * for unknown terms (how to * bread)
- SPECIFIC QUESTIONS: Use who/what/when/where/why/how
- DOMAIN TERMS: Include technical terminology for specialized topics
- CONCISE TERMS: Prioritize keywords over sentences`;

export const COUNTRY_DESCRIPTION = `Country to localize search results.
Give an ISO 3166-1 alpha-2 code ("us", "gb", "ca", "de", "fr", "jp", "br") or the country's English name.
Provide this when the search should return results specific to a particular country.
Examples:
- "us" for United States (default)
- "de" for Germany
- "in" for India`;

export const READ_PAGES_DESCRIPTION = `How many of the top results to open and read in full, 0 to 5. Defaults to 0, which reads only the snippets.
A snippet says whether a page is relevant; it does not carry the argument, the numbers, or the exact wording.
Raise this when the answer depends on what a page actually says — a specification, a changelog, a court filing, a benchmark table, a quote you intend to reproduce.
Leave it at 0 when the snippets already settle the question, such as a date, a name, or which of two things exists.`;

export const WEB_SEARCH_DESCRIPTION = `Real-time search. Results have required citation anchors.

Note: Use ONCE per reply unless instructed otherwise.

Anchors:
- \\ue202turnXtypeY
- X = turn idx, type = 'search' | 'news' | 'image' | 'ref', Y = item idx

Special Markers:
- \\ue203...\\ue204 — highlight start/end of cited text (for Standalone or Group citations)
- \\ue200...\\ue201 — group block (e.g. \\ue200\\ue202turn0search1\\ue202turn0news2\\ue201)

**CITE EVERY NON-OBVIOUS FACT/QUOTE:**
Use anchor marker(s) immediately after the statement:
- Standalone: "Pure functions produce same output. \\ue202turn0search0"
- Standalone (multiple): "Today's News \\ue202turn0search0\\ue202turn0news0"
- Highlight: "\\ue203Highlight text.\\ue204\\ue202turn0news1"
- Group: "Sources. \\ue200\\ue202turn0search0\\ue202turn0news1\\ue201"
- Group Highlight: "\\ue203Highlight for group.\\ue204 \\ue200\\ue202turn0search0\\ue202turn0news1\\ue201"
- Image: "See photo \\ue202turn0image0."

**NEVER use markdown links, [1], or footnotes. CITE ONLY with anchors provided.**`;

/**
 * The wording used to open with "semantic search across attached documents",
 * which is where a real misbehaviour came from: a document sent with the current
 * message has its text in the prompt already, and a tool that advertises itself
 * as the way to read attachments got called anyway — library-wide — after which
 * the model answered about whichever other file ranked first. The tool is for
 * finding things in the library. Reading what the reader just handed over is not
 * a search problem.
 */
export const FILE_SEARCH_DESCRIPTION = `Searches the reader's document library by meaning, and returns the passages that best match your query. Use it to find where something is said across files you have not been shown, or to reach the rest of a document whose text arrived truncated.

Do NOT use it to read a document attached to the current message: that text is already in your context, under "Documents attached to this message". Searching for it returns passages from unrelated files and is how a summary of the wrong document happens.

**CITE FILE SEARCH RESULTS:**
Use the EXACT anchor markers shown below (copy them verbatim) immediately after statements derived from file content. Reference the filename in your text:
- File citation: "The document.pdf states that... \\ue202turn0file0"  
- Page reference: "According to report.docx... \\ue202turn0file1"
- Multi-file: "Multiple sources confirm... \\ue200\\ue202turn0file0\\ue202turn0file1\\ue201"

**CRITICAL:** Output these escape sequences EXACTLY as shown (e.g. \\ue202turn0file0). Do NOT substitute with other characters like † or similar symbols.
**ALWAYS mention the filename in your text before the citation marker. NEVER use markdown links or footnotes.**`;

export const FILE_SEARCH_QUERY_DESCRIPTION =
  "A natural language query to search for relevant information in the files. Be specific and use keywords related to the information you're looking for. The query will be used for semantic similarity matching against the file contents.";

/**
 * Scoping is offered because the unscoped tool answered the wrong question. A
 * search of the whole library is right for "which of my documents mentions
 * this" and wrong for "what does that file say", and given only the second the
 * model would read back passages from unrelated files.
 */
export const FILE_SEARCH_IDS_DESCRIPTION = `Optional. Restrict the search to these exact file ids, in the form \`file_<32 lowercase hexadecimal characters>\`.
Pass them when the question is about a particular document — one attached to a message, or one the reader named — so passages from unrelated files cannot come back as the answer.
Leave this out to search the whole library, which is what a question like "which of my files covers X" wants.
A document attached to the current message already has its text in front of you; only search it when the text was truncated.`;

export const SET_MEMORY_DESCRIPTION = "Saves important information about the user into memory.";

export const DELETE_MEMORY_DESCRIPTION =
  "Deletes specific memory data about the user using the provided key. For updating existing memories, use the `set_memory` tool instead";

export const SET_MEMORY_VALUE_DESCRIPTION =
  "Value MUST be a complete sentence that fully describes relevant user information.";
