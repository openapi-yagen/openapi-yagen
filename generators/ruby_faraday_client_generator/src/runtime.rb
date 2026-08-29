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

  # Constraint-check helpers used by each generated model's validate! (see model_class.rb.j2 and
  # lib/serialization.js's buildValidateStatements) - part of this generator's answer to
  # AGENTS.md's "a generator for a dynamically-typed target language must generate its own runtime
  # checks" convention: Ruby has no compiler to reject an out-of-spec value the way the
  # TypeScript/Kotlin generators' static types do. Each is a no-op when `value` is nil (an absent
  # optional field has nothing to check) and raises ArgumentError, naming the field, on violation -
  # mirrors kotlin_ktor_server_generator's Validation.kt (requireMin/requireMax/requireMinLength/
  # requireMaxLength/requirePattern) closely, just validating outgoing client data here instead of
  # incoming server data. Only generated/called at all when the `validate` generator variable is
  # "true" (the default) - see model_class.rb.j2.

  # Basic type check, generated for every scalar property regardless of whether the schema
  # declares any constraintsOf() keywords - without this, a property with no minLength/minimum/...
  # at all would get an empty (looks-broken) validate!, since every other check here is opt-in per
  # constraint keyword. `klass` is String/Integer/Numeric - see buildValidateStatements.
  def require_type(value, klass, field)
    raise TypeError, "\"#{field}\" has the wrong type: expected #{klass}, got #{value.class}" if value && !value.is_a?(klass)
  end

  # Ruby has no single Boolean class to hand require_type - true/false are TrueClass/FalseClass.
  def require_boolean(value, field)
    raise TypeError, "\"#{field}\" must be true or false, got #{value.class}" unless value.nil? || value == true || value == false
  end

  # `format: binary` (a multipart file field) has no single Ruby class the way a string/integer/
  # boolean property does - a caller might supply a plain String (an in-memory buffer), a
  # File/IO/StringIO (anything responding to :read), or a Faraday::Multipart::FilePart/other
  # UploadIO-shaped object (anything responding to :content_type) - deliberately not checked
  # against Faraday::Multipart::FilePart directly, since faraday-multipart is an optional gem this
  # generator's own runtime has no hard dependency on (see README's "multipart/form-data" section).
  def require_string_or_file(value, field)
    return if value.nil? || value.is_a?(String) || value.respond_to?(:read) || value.respond_to?(:content_type)

    raise TypeError, "\"#{field}\" must be a String, a File/IO, or an UploadIO-shaped object, got #{value.class}"
  end

  def require_min(value, min, field)
    raise ArgumentError, "\"#{field}\" must be >= #{min}" if value && value < min
  end

  def require_max(value, max, field)
    raise ArgumentError, "\"#{field}\" must be <= #{max}" if value && value > max
  end

  def require_exclusive_min(value, min, field)
    raise ArgumentError, "\"#{field}\" must be > #{min}" if value && value <= min
  end

  def require_exclusive_max(value, max, field)
    raise ArgumentError, "\"#{field}\" must be < #{max}" if value && value >= max
  end

  # `%` on a Float can be imprecise (0.1 % 0.1 isn't always exactly 0) - acceptable for the same
  # reason multipleOf itself is a fairly coarse OpenAPI constraint; exact for the common Integer case.
  def require_multiple_of(value, multiple, field)
    raise ArgumentError, "\"#{field}\" must be a multiple of #{multiple}" if value && !(value % multiple).zero?
  end

  def require_min_length(value, min, field)
    raise ArgumentError, "\"#{field}\" must have length >= #{min}" if value && value.length < min
  end

  def require_max_length(value, max, field)
    raise ArgumentError, "\"#{field}\" must have length <= #{max}" if value && value.length > max
  end

  def require_pattern(value, pattern, field)
    raise ArgumentError, "\"#{field}\" does not match pattern #{pattern}" if value && !Regexp.new(pattern).match?(value)
  end

  def require_min_items(value, min, field)
    raise ArgumentError, "\"#{field}\" must have at least #{min} item(s)" if value && value.length < min
  end

  def require_max_items(value, max, field)
    raise ArgumentError, "\"#{field}\" must have at most #{max} item(s)" if value && value.length > max
  end

  def require_unique_items(value, field)
    raise ArgumentError, "\"#{field}\" must not contain duplicate items" if value && value.uniq.length != value.length
  end

  def require_enum(value, all_values, field)
    raise ArgumentError, "\"#{field}\" must be one of #{all_values.inspect}, got #{value.inspect}" if value && !all_values.include?(value)
  end

  # Resolves `auth_alternatives` (if the operation needs auth - see each generated method's
  # `auth:` argument) against `auth_config` (the `auth:` Hash passed to the client's own
  # constructor - see api_client.rb.j2). `auth_alternatives` is an Array of OR-alternatives, each
  # itself an Array of AND-combined requirement Hashes (`{kind:, location:, name:}`) - this picks
  # the first alternative (in the spec's own declared order) whose every scheme has a configured
  # provider, then applies each of that alternative's credentials: an Authorization header
  # (:bearer) or wherever the apiKey scheme's :location says (header/query/cookie). This is a
  # one-time credential-availability check, not a series of trial HTTP requests - exactly one
  # request is ever sent, using whichever alternative was picked. Mutates `headers` and `cookies`
  # and returns a possibly-extended `query` Hash (an apiKey in query position can't be added to
  # `headers`, so it's merged into the query Hash instead, before build_query runs).
  def apply_auth(auth_alternatives, auth_config, headers, query, cookies)
    return query if auth_alternatives.nil? || auth_alternatives.empty?

    alternative = auth_alternatives.find { |alt| alt.all? { |req| auth_config && auth_config[req[:kind]] } }
    unless alternative
      described = auth_alternatives.map { |alt| alt.map { |req| "auth[:#{req[:kind]}]" }.join(" and ") }.join(", or ")
      raise ArgumentError, "this operation requires #{described}, but none of those were fully provided"
    end

    resolved_query = query
    alternative.each do |req|
      value = resolve(auth_config[req[:kind]])
      if req[:kind] == :bearer
        headers["Authorization"] = "Bearer #{value}"
        next
      end
      case req[:location]
      when :query
        resolved_query = (resolved_query || {}).merge(req[:name] => value)
      when :cookie
        cookies[req[:name]] = value
      else
        headers[req[:name]] = value
      end
    end
    resolved_query
  end

  # Joins a Hash of cookie name/value pairs into a single "name=value; name2=value2" Cookie header
  # value (HTTP allows only one Cookie header, semicolon-separated - unlike Set-Cookie, which
  # repeats) - used for both `in: cookie` parameters and a cookie-located apiKey security scheme
  # (see apply_auth above), both funneled through the same `cookies` Hash so either source, or
  # both together, end up on one header. Returns nil (not "") when there's nothing to encode, so
  # the caller can skip setting the header entirely.
  def build_cookie_header(cookies)
    pairs = (cookies || {}).compact
    return nil if pairs.empty?

    pairs.map { |k, v| "#{URI.encode_www_form_component(k)}=#{URI.encode_www_form_component(v.to_s)}" }.join("; ")
  end

  # Performs one HTTP request over the caller-supplied Faraday::Connection and returns the parsed
  # JSON response body (a plain Hash/Array/String/Numeric/true/false/nil, exactly as JSON.parse
  # would return it - the generated operation method is what turns this into a typed model via its
  # response's own from_h, see api_client.rb.j2). Raises ApiError for any non-2xx response - the
  # parsed (or raw-text) body is still attached to the error, so callers can inspect it (e.g. a
  # structured error payload) without a second request.
  #
  # `content_type:` picks how `body` (already wire-shaped - a Hash, from the generated model's own
  # to_wire, or already a plain String for :text/:bytes - see the generator's operations.js) gets
  # encoded:
  #   :json        - JSON.generate, Content-Type: application/json (default).
  #   :urlencoded  - URI.encode_www_form (stdlib), Content-Type: application/x-www-form-urlencoded.
  #   :multipart   - passed straight through as the Faraday request body, UNMODIFIED, with no
  #                  Content-Type set here at all - the caller's own installed
  #                  Faraday::Multipart::Middleware (gem "faraday-multipart") performs the actual
  #                  MIME encoding (boundary generation, per-part headers) once the request reaches
  #                  it. This module never hand-rolls multipart encoding itself - see the
  #                  generator's README for why (same "caller owns Faraday-specific concerns"
  #                  reasoning as never creating the Faraday::Connection itself).
  #   :text/:bytes - passed straight through as the Faraday request body, UNMODIFIED (already a
  #                  plain Ruby String either way - Ruby has no separate byte-array type for an HTTP
  #                  body), Content-Type set to `media_type:` (the operation's exact declared media
  #                  type, e.g. "text/csv" or "application/octet-stream" - required whenever
  #                  content_type: is :text/:bytes).
  #
  # `response_encoding:` picks how a 2xx response body is turned into the return value - a non-2xx
  # response always gets the permissive JSON-or-fall-back-to-text treatment below regardless, since
  # an error body (however the operation's happy path is shaped) is virtually always JSON or text,
  # never a raw byte stream:
  #   :json (default) - JSON.parse, falling back to the raw response text if that fails.
  #   :text           - the raw response text, no JSON.parse attempt.
  #   :bytes          - the raw response text, forced to ASCII-8BIT (binary) encoding so it isn't
  #                      silently mangled as if it were text in whatever encoding the response
  #                      happened to declare (or Ruby's default, absent that).
  def request(connection:, method:, path:, query: nil, headers: nil, cookies: nil, body: nil, content_type: :json,
              media_type: nil, response_encoding: :json, auth: nil, auth_config: nil)
    resolved_headers = (headers || {}).compact
    resolved_cookies = (cookies || {}).compact

    resolved_query = apply_auth(auth, auth_config, resolved_headers, query, resolved_cookies)
    query_string = build_query(resolved_query)
    full_path = query_string.empty? ? path : "#{path}?#{query_string}"

    cookie_header = build_cookie_header(resolved_cookies)
    resolved_headers["Cookie"] = cookie_header if cookie_header

    request_body = nil
    unless body.nil?
      case content_type
      when :urlencoded
        request_body = URI.encode_www_form(body)
        resolved_headers["Content-Type"] = "application/x-www-form-urlencoded"
      when :multipart
        request_body = body
      when :text, :bytes
        request_body = body
        resolved_headers["Content-Type"] = media_type
      else
        request_body = JSON.generate(body)
        resolved_headers["Content-Type"] = "application/json"
      end
    end

    response = connection.run_request(method, full_path, request_body, resolved_headers)
    ok = response.status >= 200 && response.status < 300

    text = response.body.to_s
    parsed =
      if text.empty?
        nil
      elsif ok && response_encoding == :bytes
        text.dup.force_encoding(Encoding::ASCII_8BIT)
      elsif ok && response_encoding == :text
        text
      else
        begin
          JSON.parse(text)
        rescue JSON::ParserError
          text
        end
      end

    raise ApiError.new(response.status, parsed) unless ok
    parsed
  end
end
