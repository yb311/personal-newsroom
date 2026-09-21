package core

import (
	"bytes"
	"strings"
	"time"

	"github.com/yb311/personal-newsroom/native/reader/third_party/miniflux/reader/date"
	rxml "github.com/yb311/personal-newsroom/native/reader/third_party/miniflux/reader/xml"
)

// Google News sitemaps are used where a publisher has no usable RSS (Reuters,
// AP, USA Today). Miniflux does not read them, so the structure is parsed here,
// with Miniflux's XML decoder for the charset handling and invalid-character
// filtering, and its date parser for the many date formats in the wild.

type sitemapURL struct {
	Loc     string `xml:"loc"`
	LastMod string `xml:"lastmod"`
	News    struct {
		Title           string `xml:"title"`
		PublicationDate string `xml:"publication_date"`
		Publication     struct {
			Language string `xml:"language"`
		} `xml:"publication"`
	} `xml:"news"`
	Images []struct {
		Loc string `xml:"loc"`
	} `xml:"image"`
}

type urlset struct {
	URLs []sitemapURL `xml:"url"`
}

type sitemapIndex struct {
	Sitemaps []struct {
		Loc string `xml:"loc"`
	} `xml:"sitemap"`
}

func decodeXML(body []byte, v any) error {
	if err := rxml.NewXMLDecoder(bytes.NewReader(body)).Decode(v); err != nil {
		return fail("parse_error", err.Error())
	}
	return nil
}

func parseSitemap(body []byte, res *FeedResult) error {
	var set urlset
	if err := decodeXML(body, &set); err != nil {
		return err
	}
	res.Fetched += len(set.URLs)
	for _, u := range set.URLs {
		loc := strings.TrimSpace(u.Loc)
		title := Plain(u.News.Title)
		raw := strings.TrimSpace(u.News.PublicationDate)
		if raw == "" {
			raw = strings.TrimSpace(u.LastMod)
		}
		switch {
		case !strings.HasPrefix(loc, "http"):
			res.Dropped["no_url"]++
			continue
		case title == "":
			res.Dropped["no_title"]++
			continue
		}
		// A sitemap entry without a date cannot be placed in time at all; unlike
		// a feed item it has no other content either, so it is dropped.
		published, err := date.Parse(raw)
		if raw == "" || err != nil {
			res.Dropped["no_date"]++
			continue
		}
		it := Item{Title: title, URL: loc, PublishedAt: published.UTC().Format(time.RFC3339),
			Lang: PickLang(u.News.Publication.Language, title)}
		if len(u.Images) > 0 {
			it.ImageURL = strings.TrimSpace(u.Images[0].Loc)
		}
		res.Items = append(res.Items, it)
	}
	return nil
}

// A sitemap index points at child sitemaps; the newest few are enough.
const maxChildSitemaps = 4

func parseSitemapIndex(body []byte, res *FeedResult) error {
	var idx sitemapIndex
	if err := decodeXML(body, &idx); err != nil {
		return err
	}
	for _, s := range idx.Sitemaps {
		if loc := strings.TrimSpace(s.Loc); loc != "" && len(res.Children) < maxChildSitemaps {
			res.Children = append(res.Children, loc)
		}
	}
	return nil
}
