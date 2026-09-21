// Added by this project, not part of Miniflux. scripts/sync-miniflux.sh copies
// the overlay/ tree on top of the synced packages after every sync.
//
// Miniflux keeps its per-site content selectors private to ScrapeWebsite,
// which also fetches the page itself. The reader core fetches once and then
// decides between these selectors and go-trafilatura, so it needs them apart.

package scraper

import "io"

// PredefinedRules returns Miniflux's CSS selector for the article body on this
// page's site, or "" when Miniflux has none.
func PredefinedRules(pageURL string) string { return getPredefinedScraperRules(pageURL) }

// ContentUsingRules returns the outer HTML of every element the selector matches.
func ContentUsingRules(page io.Reader, rules string) (baseURL, content string, err error) {
	return findContentUsingCustomRules(page, rules)
}
