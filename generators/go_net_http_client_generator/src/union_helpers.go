package models

import "encoding/json"

// marshalWithDiscriminator marshals value normally, then splices discriminatorKey/
// discriminatorValue into the resulting JSON object - used by a discriminated union's
// MarshalJSON so its variant structs never need to carry a redundant discriminator field of
// their own.
func marshalWithDiscriminator(value any, discriminatorKey, discriminatorValue string) ([]byte, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil, err
	}
	discBytes, err := json.Marshal(discriminatorValue)
	if err != nil {
		return nil, err
	}
	fields[discriminatorKey] = discBytes
	return json.Marshal(fields)
}

func hasKey(m map[string]json.RawMessage, key string) bool {
	_, ok := m[key]
	return ok
}
