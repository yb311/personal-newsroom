package core

import (
	nurl "net/url"
	"strings"

	"github.com/yb311/personal-newsroom/native/reader/third_party/miniflux/reader/scraper"
)

// siteRules maps a site to the CSS selector of its article body, for sites
// where the general extractor measurably picks up page chrome. This is the
// mechanism Miniflux uses (its table is consulted first); entries here only
// cover sites Miniflux has none for, and each one should come with a saved page
// in testdata/ that shows why it is needed.
//
// Keys match the host and any of its subdomains.
var siteRules = map[string]string{
	// Article pages carry the site logo, a font-size toggle, a share bar and an
	// app-download list inside the same container as the text.
	"people.com.cn": ".rm_txt_con",
}

// rulesFor returns the body selector for pageURL, Miniflux's first.
func rulesFor(pageURL string) string {
	if r := scraper.PredefinedRules(pageURL); r != "" {
		return r
	}
	u, err := nurl.Parse(pageURL)
	if err != nil {
		return ""
	}
	host := strings.TrimPrefix(strings.ToLower(u.Hostname()), "www.")
	for {
		if r, ok := siteRules[host]; ok {
			return r
		}
		i := strings.IndexByte(host, '.')
		if i < 0 || !strings.Contains(host[i+1:], ".") {
			return ""
		}
		host = host[i+1:]
	}
}
