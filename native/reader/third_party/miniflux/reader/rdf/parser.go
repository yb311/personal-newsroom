// SPDX-FileCopyrightText: Copyright The Miniflux Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package rdf // import "github.com/yb311/personal-newsroom/native/reader/third_party/miniflux/reader/rdf"

import (
	"fmt"
	"io"

	"github.com/yb311/personal-newsroom/native/reader/third_party/miniflux/model"
	"github.com/yb311/personal-newsroom/native/reader/third_party/miniflux/reader/xml"
)

// Parse returns a normalized feed struct from a RDF feed.
func Parse(baseURL string, data io.ReadSeeker) (*model.Feed, error) {
	xmlFeed := new(rdf)
	if err := xml.NewXMLDecoder(data).Decode(xmlFeed); err != nil {
		return nil, fmt.Errorf("rdf: unable to parse feed: %w", err)
	}

	adapter := &rdfAdapter{xmlFeed}
	return adapter.buildFeed(baseURL), nil
}
