// SPDX-FileCopyrightText: Copyright The Miniflux Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package parser // import "github.com/yb311/personal-newsroom/native/reader/third_party/miniflux/reader/parser"

import (
	"errors"
	"io"

	"github.com/yb311/personal-newsroom/native/reader/third_party/miniflux/model"
	"github.com/yb311/personal-newsroom/native/reader/third_party/miniflux/reader/atom"
	"github.com/yb311/personal-newsroom/native/reader/third_party/miniflux/reader/json"
	"github.com/yb311/personal-newsroom/native/reader/third_party/miniflux/reader/rdf"
	"github.com/yb311/personal-newsroom/native/reader/third_party/miniflux/reader/rss"
)

var ErrFeedFormatNotDetected = errors.New("parser: unable to detect feed format")

// ParseFeed analyzes the input data and returns a normalized feed object.
func ParseFeed(baseURL string, r io.ReadSeeker) (*model.Feed, error) {
	format, version := DetectFeedFormat(r)
	switch format {
	case FormatAtom:
		return atom.Parse(baseURL, r, version)
	case FormatRSS:
		return rss.Parse(baseURL, r)
	case FormatJSON:
		return json.Parse(baseURL, r)
	case FormatRDF:
		return rdf.Parse(baseURL, r)
	default:
		return nil, ErrFeedFormatNotDetected
	}
}
