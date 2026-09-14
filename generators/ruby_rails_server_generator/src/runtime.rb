# Shared runtime for generated Rails server code - copied into the output directory verbatim (no
# per-spec substitution needed, same as ruby_faraday_client_generator's runtime.rb). Every
# generated model and controller/concern calls into this module instead of duplicating
# parameter-parsing/constraint-checking/auth-verification logic per operation.
#
# Part of this generator's answer to AGENTS.md's "a generator for a dynamically-typed target
# language must generate its own runtime checks" convention: Ruby has no compiler to reject a
# wrong-shaped or out-of-spec value the way the TypeScript/Kotlin generators' static types do for
# free - and unlike ruby_faraday_client_generator (which only ever constructs an outgoing request
# from values the caller's own code already produced), a server receives values from an untrusted
# client, so these checks are load-bearing, not a nice-to-have. Mirrors
# python_tornado_server_generator's runtime.py closely - same split between ValidationError (a
# malformed request) and MissingAuthenticationError (an unauthenticated one), same constraint-check
# helper family - adapted to Ruby idiom (raise/rescue, Date/Time instead of datetime.date/
# datetime.datetime).
#
# This module is a plain top-level constant (not namespaced under the generated moduleName),
# exactly like ruby_faraday_client_generator's own OpenapiYagenRuntime - see that generator's
# runtime.rb and templates for the same convention. Generating two different APIs' worth of code
# into the same app both pick up this same top-level module, which is fine: it's stateless and
# identical either way.

require "date"
require "time"
require "uri"

module OpenapiYagenRuntime
  # Raised when an incoming request parameter or body value fails validation - either a basic type
  # check or an OpenAPI-level constraint (minLength/pattern/minimum/.../format:uuid). Deliberately
  # generic and app-agnostic: the generated controller/concern maps this to a 422 JSON response -
  # see each generated controller.rb.j2/controller_concern.rb.j2 and the generator's README
  # "Integrating the generated code".
  class ValidationError < StandardError; end

  # Raised when an operation's required security-scheme credentials (a bearer token or apiKey) are
  # absent from the request - deliberately NOT a subclass of ValidationError: this means "you
  # haven't authenticated", not "your request is malformed", so it's mapped to a distinct HTTP
  # status (401) rather than ValidationError's 422.
  class MissingAuthenticationError < StandardError; end

  module_function

  # Constraint-check helpers used by each generated model's validate! (see model_class.rb.j2 and
  # lib/serialization.js's buildValidateStatements), and by the generated controller/concern layer
  # for path/query/header/cookie parameters. Each is a no-op when `value` is nil (an absent
  # optional field/parameter has nothing to check) and raises ValidationError, naming the field, on
  # violation. Only generated/called at all when the `validate` generator variable is "true" (the
  # default) - see model_class.rb.j2/controller.rb.j2/controller_concern.rb.j2.

  # Basic type check, generated for every scalar property regardless of whether the schema
  # declares any constraintsOf() keywords - without this, a property with no minLength/minimum/...
  # at all would get an empty (looks-broken) validate!, since every other check here is opt-in per
  # constraint keyword. `klass` is String/Integer/Numeric/Date/Time - see buildValidateStatements.
  def require_type(value, klass, field)
    raise ValidationError, "\"#{field}\" has the wrong type: expected #{klass}, got #{value.class}" if value && !value.is_a?(klass)
  end

  # Ruby has no single Boolean class to hand require_type - true/false are TrueClass/FalseClass.
  def require_boolean(value, field)
    raise ValidationError, "\"#{field}\" must be true or false, got #{value.class}" unless value.nil? || value == true || value == false
  end

  # `format: binary` (a multipart file field) has no single Ruby class the way a string/integer/
  # boolean property does - a caller might supply a plain String (an in-memory buffer), a
  # File/IO/StringIO (anything responding to :read), or an ActionDispatch::Http::UploadedFile
  # (anything responding to :content_type) - Rails already hands the generated controller/concern
  # one of the latter for an uploaded multipart part, but a value built directly (e.g. in a test)
  # might be any of these.
  def require_string_or_file(value, field)
    return if value.nil? || value.is_a?(String) || value.respond_to?(:read) || value.respond_to?(:content_type)

    raise ValidationError, "\"#{field}\" must be a String, a File/IO, or an uploaded-file-shaped object, got #{value.class}"
  end

  def require_min(value, min, field)
    raise ValidationError, "\"#{field}\" must be >= #{min}" if value && value < min
  end

  def require_max(value, max, field)
    raise ValidationError, "\"#{field}\" must be <= #{max}" if value && value > max
  end

  def require_exclusive_min(value, min, field)
    raise ValidationError, "\"#{field}\" must be > #{min}" if value && value <= min
  end

  def require_exclusive_max(value, max, field)
    raise ValidationError, "\"#{field}\" must be < #{max}" if value && value >= max
  end

  # `%` on a Float can be imprecise (0.1 % 0.1 isn't always exactly 0) - acceptable for the same
  # reason multipleOf itself is a fairly coarse OpenAPI constraint; exact for the common Integer case.
  def require_multiple_of(value, multiple, field)
    raise ValidationError, "\"#{field}\" must be a multiple of #{multiple}" if value && !(value % multiple).zero?
  end

  def require_min_length(value, min, field)
    raise ValidationError, "\"#{field}\" must have length >= #{min}" if value && value.length < min
  end

  def require_max_length(value, max, field)
    raise ValidationError, "\"#{field}\" must have length <= #{max}" if value && value.length > max
  end

  def require_pattern(value, pattern, field)
    raise ValidationError, "\"#{field}\" does not match pattern #{pattern}" if value && !Regexp.new(pattern).match?(value)
  end

  def require_min_items(value, min, field)
    raise ValidationError, "\"#{field}\" must have at least #{min} item(s)" if value && value.length < min
  end

  def require_max_items(value, max, field)
    raise ValidationError, "\"#{field}\" must have at most #{max} item(s)" if value && value.length > max
  end

  def require_unique_items(value, field)
    raise ValidationError, "\"#{field}\" must not contain duplicate items" if value && value.uniq.length != value.length
  end

  def require_min_properties(value, min, field)
    raise ValidationError, "\"#{field}\" must have at least #{min} propert(y/ies)" if value && value.length < min
  end

  def require_max_properties(value, max, field)
    raise ValidationError, "\"#{field}\" must have at most #{max} propert(y/ies)" if value && value.length > max
  end

  def require_enum(value, all_values, field)
    raise ValidationError, "\"#{field}\" must be one of #{all_values.inspect}, got #{value.inspect}" if value && !all_values.include?(value)
  end

  # Canonical 8-4-4-4-12 hyphenated hex form (RFC 4122 section 3) - version/variant bits aren't
  # checked, matching how require_max/require_max_length/require_pattern above are also shape
  # checks only, not full semantic validation. Mirrors python_tornado_server_generator's
  # require_uuid. `format: date`/`date-time` need no analogous check here - they're already typed
  # as Date/Time (see lib/types.js), so parse_date/parse_datetime below already reject a malformed
  # value at from_h time, the same way a plain String property/parameter never happens for
  # format: date/date-time the way it still does for format: uuid. The pattern is an inline
  # literal, not a module constant - OpenapiYagenRuntime is a plain top-level module (see this
  # file's header comment), so generating two different APIs' worth of code into the same app
  # reopens it twice; a Regexp literal silently recompiles either time, but a `CONST =` reassignment
  # would print a "already initialized constant" warning on the second load.
  def require_uuid(value, field)
    pattern = /\A[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\z/
    raise ValidationError, "\"#{field}\" must be a valid UUID" if value && !pattern.match?(value)
  end

  # Parsing IS the validation for format:date/date-time (see lib/serialization.js's
  # buildFromHExpr) - nil-safe (an absent/explicitly-null property has nothing to parse).
  def parse_date(value)
    return nil if value.nil?

    Date.iso8601(value)
  rescue ArgumentError, TypeError
    raise ValidationError, "invalid date value: #{value.inspect}"
  end

  def parse_datetime(value)
    return nil if value.nil?

    Time.iso8601(value)
  rescue ArgumentError, TypeError
    raise ValidationError, "invalid date-time value: #{value.inspect}"
  end

  # Path/query/header parameters arrive from Rails' `params` as plain Strings (or arrays of them)
  # regardless of their declared schema type - these parse-and-validate a single parameter value,
  # raising ValidationError (naming the field) on a malformed value, the same "parse IS the
  # validation" idea as parse_date/parse_datetime above but for a labeled parameter position
  # instead of a body property.
  def require_param(params, name)
    value = params[name]
    raise ValidationError, "\"#{name}\" is required" if value.nil?

    value
  end

  def param(params, name)
    params[name]
  end

  def parse_int(value, field)
    return nil if value.nil?

    Integer(value)
  rescue ArgumentError, TypeError
    raise ValidationError, "\"#{field}\" must be an integer, got #{value.inspect}"
  end

  def parse_float(value, field)
    return nil if value.nil?

    Float(value)
  rescue ArgumentError, TypeError
    raise ValidationError, "\"#{field}\" must be a number, got #{value.inspect}"
  end

  def parse_bool(value, field)
    return nil if value.nil?
    return true if %w[true 1].include?(value.to_s.downcase)
    return false if %w[false 0].include?(value.to_s.downcase)

    raise ValidationError, "\"#{field}\" must be a boolean, got #{value.inspect}"
  end

  def parse_date_param(value, field)
    return nil if value.nil?

    Date.iso8601(value)
  rescue ArgumentError, TypeError
    raise ValidationError, "\"#{field}\" must be a valid date (YYYY-MM-DD), got #{value.inspect}"
  end

  def parse_datetime_param(value, field)
    return nil if value.nil?

    Time.iso8601(value)
  rescue ArgumentError, TypeError
    raise ValidationError, "\"#{field}\" must be a valid date-time (ISO 8601), got #{value.inspect}"
  end

  # Rails' `params` already merges route/query params together - `request.request_parameters`
  # (ActionDispatch, body-only) is used instead for the body itself, so a body key never gets
  # confused with a same-named path/query parameter. Returns a wire-shaped (string-keyed) Hash
  # (or, for a multipart file field, an ActionDispatch::Http::UploadedFile), ready for a generated
  # model's own from_h.
  def body_params(request)
    request.request_parameters
  end

  # `request.headers[...]`/`request.cookies[...]` both work with no middleware dependency (unlike
  # `request.cookie_jar`, which needs the ActionDispatch::Cookies middleware in the stack) -
  # ActionDispatch::Http::Headers#[] already does the env-key translation ("X-Request-Id" <->
  # "HTTP_X_REQUEST_ID") internally, and #cookies is a plain Rack-level helper reading the raw
  # Cookie header. Nil-safe passthroughs - a missing header/cookie is simply nil, no exception.
  def header(request, name)
    request.headers[name]
  end

  def require_header(request, name)
    value = header(request, name)
    raise ValidationError, "\"#{name}\" header is required" if value.nil?

    value
  end

  def cookie(request, name)
    request.cookies[name]
  end

  def require_cookie(request, name)
    value = cookie(request, name)
    raise ValidationError, "\"#{name}\" cookie is required" if value.nil?

    value
  end

  # A query parameter serialized as OpenAPI 3's default array style (`style: form, explode: true`
  # - a repeated key, e.g. "tags=a&tags=b", NOT bracket-suffixed "tags[]=a&tags[]=b") is what
  # ruby_faraday_client_generator's own build_query sends - but Rails' `params` does NOT collect
  # plain repeated non-bracket keys into an array (Rack::Utils.parse_nested_query only arrayifies
  # the "[]"-suffixed form; a bare repeated key is last-one-wins). This walks the raw query string
  # directly (URI.decode_www_form preserves every pair, duplicates included) to recover every value
  # for `name`, in request order - the only way to correctly receive the wire format this project's
  # own client generator (and OpenAPI's own default) actually produces. Returns [] (not nil) when
  # absent, since an empty repeated-key list has no distinct "explicitly null" wire form anyway.
  def query_array(request, name)
    URI.decode_www_form(request.query_string.to_s).select { |k, _| k == name }.map { |_, v| v }
  end

  # Nil-safe: returns the bearer token (without the "Bearer " prefix), or nil if `request` carries
  # no (or a malformed) `Authorization: Bearer <token>` header - used for an OR-alternative security
  # requirement, where the credential's ABSENCE isn't an error by itself (a different alternative
  # might be satisfied instead - see lib/operations.js's buildAuthResolution). Covers http/bearer,
  # oauth2, and openIdConnect security schemes alike (RFC 6750: an OAuth2/OIDC access token travels
  # as a bearer token regardless of how it was obtained), mirrors ruby_faraday_client_generator's
  # own treatment of those three schemes as equivalent.
  def bearer_token(request, header: "Authorization")
    value = header(request, header)
    match = value && /\ABearer (.+)\z/i.match(value)
    match && match[1]
  end

  # Raises MissingAuthenticationError unless `request` carries a bearer token - used when it's the
  # operation's ONLY security alternative, so its absence is unconditionally an error. Returns the
  # raw token (without the "Bearer " prefix) so the caller's own handler can verify/decode it.
  def require_bearer_token(request, header: "Authorization")
    token = bearer_token(request, header: header)
    raise MissingAuthenticationError, "missing or malformed #{header} bearer token" if token.nil?

    token
  end

  # Nil-safe apiKey lookup at `location` (:header/:query/:cookie) under `name` - see bearer_token
  # above for why this doesn't raise by itself (an OR-alternative security requirement).
  def api_key(request, location:, name:)
    case location
    when :header then header(request, name)
    when :query then request.parameters[name]
    when :cookie then cookie(request, name)
    end
  end

  # Raises MissingAuthenticationError unless an apiKey security scheme's credential is present -
  # used when it's the operation's ONLY security alternative. Returns the raw value.
  def require_api_key(request, location:, name:)
    value = api_key(request, location: location, name: name)
    raise MissingAuthenticationError, "missing required apiKey \"#{name}\" (#{location})" if value.nil?

    value
  end
end
