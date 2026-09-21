// SPDX-FileCopyrightText: Copyright The Miniflux Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package json // import "github.com/yb311/personal-newsroom/native/reader/third_party/miniflux/reader/json"

import (
	"encoding/json"
	"fmt"
	"io"

	"github.com/yb311/personal-newsroom/native/reader/third_party/miniflux/model"
)

// Parse returns a normalized feed struct from a JSON feed.
func Parse(baseURL string, data io.Reader) (*model.Feed, error) {
	jsonFeed := new(JSONFeed)
	if err := json.NewDecoder(data).Decode(jsonFeed); err != nil {
		return nil, fmt.Errorf("json: unable to parse feed: %w", err)
	}

	return NewJSONAdapter(jsonFeed).BuildFeed(baseURL), nil
}
