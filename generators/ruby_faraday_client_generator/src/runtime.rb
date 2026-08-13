# Shared runtime for the generated API client - copied into the output directory verbatim (no
# per-spec substitution needed, so this is emitted via copyFile rather than a template, same as
# the TypeScript generator's runtime.ts). Every generated <Tag>Client class calls
# OpenapiYagenRuntime.request instead of duplicating the query/header/auth/JSON/error-handling
# sequence per operation.
#
# This module never picks (or creates) an HTTP engine: every generated client class takes an
# already-configured Faraday::Connection from its caller (see api_client.rb.j2/api_bundle.rb.j2),
# the Ruby analogue of the Kotlin Ktor client generator's caller-supplied HttpClient - so it works
# with whichever Faraday adapter (net_http, Typhoeus, httpx, ...) the caller's own Gemfile already
# uses. It does, however, own JSON encoding/decoding itself (there's no equivalent to Ktor's
# installed ContentNegotiation plugin to lean on) - do NOT install a JSON-parsing response
# middleware (e.g. faraday-json's Faraday::Response::Json) on the connection you inject, or
# response bodies will already be parsed Hashes by the time this module tries to parse them again.

require "json"
require "uri"

module OpenapiYagenRuntime
  # Raised whenever a response status is not in the 2xx range.
  class ApiError < StandardError
    attr_reader :status, :response_body

    def initialize(status, response_body)
      super("API error #{status}")
      @status = status
      @response_body = response_body
    end
  end

  module_function

  # Static value, or a zero-arg callable re-invoked on every request - the callable form is what
  # makes a rotating/expiring bearer token actually correct, since a value captured once at
  # construction would go stale. Mirrors the TypeScript generator's HeaderProvider/AuthProvider.
  def resolve(value)
    value.respond_to?(:call) ? value.call : value
  end

  # Percent-encodes a single path segment's interpolated value (RFC 3986 unreserved characters
  # only pass through unescaped) - the Ruby equivalent of the TypeScript generator's
  # `encodeURIComponent(String(value))` call in its own generated path expressions.
  def escape_path_segment(value)
    URI::DEFAULT_PARSER.escape(value.to_s, /[^a-zA-Z0-9\-_.~]/)
  end

  # Builds an already-escaped query string from a wire-name-keyed Hash whose values may be a plain
  # scalar, an Array (OpenAPI 3's default array query serialization: one repeated `key=` pair per
  # element, e.g. "tag=a&tag=b" - not a single comma-joined value), or a Hash (deepObject-style
  # filter object, e.g. a Stripe-style range filter: `{ "created" => { "gte" => 123 } }` becomes
  # "created[gte]=123"). A nil value (at any level) is skipped entirely. Returns "" (not "?") when
  # there's nothing to encode.
  def build_query(params)
    pairs = []
    (params || {}).each do |key, value|
      next if value.nil?
      case value
      when Array
        value.each { |v| pairs << [key, v] unless v.nil? }
      when Hash
        value.each { |subkey, subvalue| pairs << ["#{key}[#{subkey}]", subvalue] unless subvalue.nil? }
      else
        pairs << [key, value]
      end
    end
    pairs.map { |k, v| "#{URI.encode_www_form_component(k)}=#{URI.encode_www_form_component(v.to_s)}" }.join("&")
  end

  # Resolves `auth_requirement` (if the operation needs one - see each generated method's
  # `auth:` argument) against `auth_config` (the `auth:` Hash passed to the client's own
  # constructor - see api_client.rb.j2), applying the credential either as an Authorization header
  # (bearer) or wherever the apiKey scheme's location says (header/query). Mutates `headers` and
  # returns a possibly-extended `query` Hash (an apiKey in query position can't be added to
  # `headers`, so it's merged into the query Hash instead, before build_query runs).
  def apply_auth(auth_requirement, auth_config, headers, query)
    return query unless auth_requirement

    kind = auth_requirement[:kind]
    provider = auth_config && auth_config[kind]
    unless provider
      raise ArgumentError, "this operation requires \"#{kind}\" authentication, but the client's auth[:#{kind}] was not provided"
    end
    value = resolve(provider)

    if kind == :bearer
      headers["Authorization"] = "Bearer #{value}"
      return query
    end

    if auth_requirement[:location] == :query
      return (query || {}).merge(auth_requirement[:name] => value)
    end
    headers[auth_requirement[:name]] = value
    query
  end

  # Performs one HTTP request over the caller-supplied Faraday::Connection and returns the parsed
  # JSON response body (a plain Hash/Array/String/Numeric/true/false/nil, exactly as JSON.parse
  # would return it - the generated operation method is what turns this into a typed model via its
  # response's own from_h, see api_client.rb.j2). Raises ApiError for any non-2xx response - the
  # parsed (or raw-text) body is still attached to the error, so callers can inspect it (e.g. a
  # structured error payload) without a second request.
  def request(connection:, method:, path:, query: nil, headers: nil, body: nil, auth: nil, auth_config: nil)
    resolved_headers = (headers || {}).compact

    resolved_query = apply_auth(auth, auth_config, resolved_headers, query)
    query_string = build_query(resolved_query)
    full_path = query_string.empty? ? path : "#{path}?#{query_string}"

    body_string = nil
    unless body.nil?
      body_string = JSON.generate(body)
      resolved_headers["Content-Type"] = "application/json"
    end

    response = connection.run_request(method, full_path, body_string, resolved_headers)

    text = response.body.to_s
    parsed =
      if text.empty?
        nil
      else
        begin
          JSON.parse(text)
        rescue JSON::ParserError
          text
        end
      end

    raise ApiError.new(response.status, parsed) unless response.status >= 200 && response.status < 300
    parsed
  end
end
