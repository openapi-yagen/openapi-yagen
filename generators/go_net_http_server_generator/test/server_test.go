package servertest

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"go_net_http_server_generator_test/generated/models"
	"go_net_http_server_generator_test/generated/server"
)

type fakePetsHandler struct{}

func (fakePetsHandler) ListPets(ctx context.Context, limit *int, tag *string, tags []string, sessionId *string) (models.Pets, error) {
	pet := models.Pet{Id: 1, Name: "Rex"}
	if sessionId != nil {
		pet.Notes = sessionId
	}
	return models.Pets{pet}, nil
}

func (fakePetsHandler) CreatePet(ctx context.Context, body models.NewPet) (models.Pet, error) {
	return models.Pet{Id: 2, Name: body.Name}, nil
}

func (fakePetsHandler) GetPetById(ctx context.Context, petId string) (models.Pet, error) {
	if petId == "missing" {
		return models.Pet{}, &models.ValidationError{Field: "petId", Message: "not found"}
	}
	return models.Pet{Id: 1, Name: "Rex"}, nil
}

func (fakePetsHandler) DeletePet(ctx context.Context, petId string, bearerAuthToken string) error {
	return nil
}

func (fakePetsHandler) UploadPetAvatar(ctx context.Context, petId string, apiKeyAuthKey string, body []byte) ([]byte, error) {
	return body, nil
}

func (fakePetsHandler) SetPetNotes(ctx context.Context, petId string, body string) (string, error) {
	return body, nil
}

func (fakePetsHandler) UploadPetPhoto(ctx context.Context, petId string, body models.PetPhotoUpload) error {
	return nil
}

func (fakePetsHandler) RatePet(ctx context.Context, petId string, xRequestId string, body models.Rating) error {
	return nil
}

func (fakePetsHandler) SubscribeToPet(ctx context.Context, petId string, body models.PetSubscription) error {
	if len(body.Channels) > 0 && !(len(body.Channels) == 2 && body.Channels[0] == "sms" && body.Channels[1] == "email") {
		return fmt.Errorf("unexpected channels: %v", body.Channels)
	}
	return nil
}

type fakeWidgetsHandler struct{}

func (fakeWidgetsHandler) ListWidgets(ctx context.Context, status *models.WidgetsHandlerListWidgetsStatus, id *string, xClientVersion *string) (models.Widgets, error) {
	return models.Widgets{}, nil
}

func (fakeWidgetsHandler) CreateWidget(ctx context.Context, body models.Widget) (models.Widget, error) {
	return body, nil
}

func (fakeWidgetsHandler) GetShape(ctx context.Context, shapeId string) (models.Shape, error) {
	var shape models.Shape
	shape.FromCircle(models.Circle{Radius: 2.5})
	return shape, nil
}

func (fakeWidgetsHandler) FavoriteWidget(ctx context.Context, widgetId string, oauth2authToken *string, apiKeyAuthKey *string) error {
	return nil
}

func newTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	server.RegisterPetsRoutes(mux, fakePetsHandler{}, nil)
	server.RegisterWidgetsRoutes(mux, fakeWidgetsHandler{}, nil)
	s := httptest.NewServer(mux)
	t.Cleanup(s.Close)
	return s
}

func TestListPets(t *testing.T) {
	s := newTestServer(t)
	resp, err := http.Get(s.URL + "/pets?limit=10&tags=a&tags=b")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	var pets models.Pets
	if err := json.NewDecoder(resp.Body).Decode(&pets); err != nil {
		t.Fatal(err)
	}
	if len(pets) != 1 || pets[0].Name != "Rex" {
		t.Fatalf("unexpected pets: %+v", pets)
	}
	if pets[0].Notes != nil {
		t.Fatalf("expected no session_id cookie to leave Notes nil, got %v", *pets[0].Notes)
	}
}

func TestListPetsCookieParam(t *testing.T) {
	s := newTestServer(t)
	req, _ := http.NewRequest(http.MethodGet, s.URL+"/pets", nil)
	req.AddCookie(&http.Cookie{Name: "session_id", Value: "abc123"})
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var pets models.Pets
	if err := json.NewDecoder(resp.Body).Decode(&pets); err != nil {
		t.Fatal(err)
	}
	if len(pets) != 1 || pets[0].Notes == nil || *pets[0].Notes != "abc123" {
		t.Fatalf("expected session_id cookie to be parsed and echoed via Notes, got %+v", pets)
	}
}

func TestListPetsInvalidLimit(t *testing.T) {
	s := newTestServer(t)
	resp, err := http.Get(s.URL + "/pets?limit=notanumber")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for an unparseable limit, got %d", resp.StatusCode)
	}
}

func TestCreatePetValidation(t *testing.T) {
	s := newTestServer(t)
	resp, err := http.Post(s.URL+"/pets", "application/json", strings.NewReader(`{"name":""}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for a name violating minLength=1 (validated before the handler runs), got %d", resp.StatusCode)
	}

	resp2, err := http.Post(s.URL+"/pets", "application/json", strings.NewReader(`{"name":"Fido"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusCreated {
		t.Fatalf("expected 201 for a valid name, got %d", resp2.StatusCode)
	}
}

func TestNewPetUnmarshalJSONAppliesDefaults(t *testing.T) {
	var absent models.NewPet
	if err := json.Unmarshal([]byte(`{"name":"Fido"}`), &absent); err != nil {
		t.Fatal(err)
	}
	if absent.Priority == nil || *absent.Priority != 1 {
		t.Fatalf("expected priority to default to 1 when absent, got %v", absent.Priority)
	}
	if absent.Visibility == nil || *absent.Visibility != models.NewPetVisibilityPublic {
		t.Fatalf("expected visibility to default to %q when absent, got %v", models.NewPetVisibilityPublic, absent.Visibility)
	}

	var explicit models.NewPet
	if err := json.Unmarshal([]byte(`{"name":"Fido","priority":5,"visibility":"private"}`), &explicit); err != nil {
		t.Fatal(err)
	}
	if explicit.Priority == nil || *explicit.Priority != 5 {
		t.Fatalf("expected an explicit priority to override the default, got %v", explicit.Priority)
	}
	if explicit.Visibility == nil || *explicit.Visibility != models.NewPetVisibilityPrivate {
		t.Fatalf("expected an explicit visibility to override the default, got %v", explicit.Visibility)
	}

	var explicitNull models.NewPet
	if err := json.Unmarshal([]byte(`{"name":"Fido","priority":null}`), &explicitNull); err != nil {
		t.Fatal(err)
	}
	if explicitNull.Priority != nil {
		t.Fatalf("expected an explicit JSON null to override the default back to nil, got %v", *explicitNull.Priority)
	}
}

func TestCreatePetFormatValidation(t *testing.T) {
	s := newTestServer(t)

	resp, err := http.Post(s.URL+"/pets", "application/json", strings.NewReader(`{"name":"Fido","sku":"not-a-uuid"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for a sku violating format: uuid (validated before the handler runs), got %d", resp.StatusCode)
	}

	resp2, err := http.Post(s.URL+"/pets", "application/json", strings.NewReader(`{"name":"Fido","birthDate":"not-a-date"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for a birthDate violating format: date, got %d", resp2.StatusCode)
	}

	resp3, err := http.Post(s.URL+"/pets", "application/json", strings.NewReader(`{"name":"Fido","sku":"3fa85f64-5717-4562-b3fc-2c963f66afa6","birthDate":"2020-01-15"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp3.Body.Close()
	if resp3.StatusCode != http.StatusCreated {
		t.Fatalf("expected 201 for a valid sku/birthDate, got %d", resp3.StatusCode)
	}
}

func TestRatePetValidationFailure(t *testing.T) {
	s := newTestServer(t)
	req, _ := http.NewRequest(http.MethodPost, s.URL+"/pets/1/ratings", strings.NewReader(`{"score":10,"label":"BAD"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Request-Id", "req-1")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for a rating violating maximum/pattern, got %d", resp.StatusCode)
	}
}

func TestRatePetMissingHeader(t *testing.T) {
	s := newTestServer(t)
	resp, err := http.Post(s.URL+"/pets/1/ratings", "application/json", strings.NewReader(`{"score":5,"label":"great"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for a missing required X-Request-Id header, got %d", resp.StatusCode)
	}
}

func TestDeletePetRequiresAuth(t *testing.T) {
	s := newTestServer(t)
	req, _ := http.NewRequest(http.MethodDelete, s.URL+"/pets/1", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 with no Authorization header, got %d", resp.StatusCode)
	}

	req2, _ := http.NewRequest(http.MethodDelete, s.URL+"/pets/1", nil)
	req2.Header.Set("Authorization", "Bearer sometoken")
	resp2, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusNoContent {
		t.Fatalf("expected 204 with a bearer token present, got %d", resp2.StatusCode)
	}
}

func TestUploadPetAvatarRequiresAPIKey(t *testing.T) {
	s := newTestServer(t)
	req, _ := http.NewRequest(http.MethodPut, s.URL+"/pets/1/avatar", bytes.NewReader([]byte{1, 2, 3}))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 with no X-Api-Key header, got %d", resp.StatusCode)
	}

	req2, _ := http.NewRequest(http.MethodPut, s.URL+"/pets/1/avatar", bytes.NewReader([]byte{1, 2, 3}))
	req2.Header.Set("X-Api-Key", "secret")
	resp2, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 with an X-Api-Key header present, got %d", resp2.StatusCode)
	}
	respBody, _ := io.ReadAll(resp2.Body)
	if !bytes.Equal(respBody, []byte{1, 2, 3}) {
		t.Fatalf("unexpected echoed body: %v", respBody)
	}
}

func TestSetPetNotesText(t *testing.T) {
	s := newTestServer(t)
	resp, err := http.Post(s.URL+"/pets/1/notes", "text/plain", strings.NewReader("hello"))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if string(body) != "hello" {
		t.Fatalf("unexpected echoed notes: %q", body)
	}
}

func TestUploadPetPhotoMultipart(t *testing.T) {
	s := newTestServer(t)
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	w.WriteField("caption", "Nice dog")
	photoPart, err := w.CreateFormFile("photo", "photo.bin")
	if err != nil {
		t.Fatal(err)
	}
	photoPart.Write([]byte{1, 2, 3})
	w.Close()

	req, _ := http.NewRequest(http.MethodPost, s.URL+"/pets/1/photo", &buf)
	req.Header.Set("Content-Type", w.FormDataContentType())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", resp.StatusCode)
	}
}

func TestUploadPetPhotoMissingRequiredField(t *testing.T) {
	s := newTestServer(t)
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	w.WriteField("caption", "Nice dog")
	w.Close()

	req, _ := http.NewRequest(http.MethodPost, s.URL+"/pets/1/photo", &buf)
	req.Header.Set("Content-Type", w.FormDataContentType())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for a missing required 'photo' field, got %d", resp.StatusCode)
	}
}

func TestSubscribeToPetUrlencoded(t *testing.T) {
	s := newTestServer(t)
	form := url.Values{}
	form.Set("email", "a@example.com")
	form.Set("notify", "true")
	form.Add("channels", "sms")
	form.Add("channels", "email")
	resp, err := http.PostForm(s.URL+"/pets/1/subscribe", form)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", resp.StatusCode)
	}
}

func TestShapeValidateDelegatesToActiveVariant(t *testing.T) {
	var shape models.Shape
	shape.FromCircle(models.Circle{Radius: -1})
	if err := shape.Validate(); err == nil {
		t.Fatal("expected Shape.Validate() to delegate to Circle.Validate() and reject radius < 0")
	}

	shape.FromCircle(models.Circle{Radius: 1})
	if err := shape.Validate(); err != nil {
		t.Fatalf("expected a valid Circle to pass, got %v", err)
	}
}

func TestGetShapeDiscriminatedUnion(t *testing.T) {
	s := newTestServer(t)
	resp, err := http.Get(s.URL + "/widgets/shapes/s1")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), `"shapeType":"circle"`) {
		t.Fatalf("expected a discriminated circle in the response, got %s", body)
	}
}

func TestCreateWidgetRecursiveValidation(t *testing.T) {
	s := newTestServer(t)

	resp, err := http.Post(s.URL+"/widgets", "application/json",
		strings.NewReader(`{"id":1,"name":"Foo","tags":[{"id":1,"name":""}],"variant":"hello"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for a Tags[0].Name violating minLength=1 (found via recursive Validate() through the TagSet alias), got %d", resp.StatusCode)
	}
	msg, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(msg), `"tags[0].name"`) {
		t.Fatalf("expected the recursive error's Field to be prefixed with the array index (tags[0].name), got %q", msg)
	}

	resp2, err := http.Post(s.URL+"/widgets", "application/json",
		strings.NewReader(`{"id":1,"name":"Foo","tags":[{"id":1,"name":"x"}],"variant":"hello"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(resp2.Body)
		t.Fatalf("expected 201 for a valid nested Tags/Variant, got %d: %s", resp2.StatusCode, body)
	}
}

func TestFavoriteWidgetORSecurityAlternatives(t *testing.T) {
	s := newTestServer(t)

	// Neither oauth2Auth (Authorization: Bearer ...) nor apiKeyAuth (X-Api-Key) present.
	req, _ := http.NewRequest(http.MethodPost, s.URL+"/widgets/w1/favorite", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 with neither alternative present, got %d", resp.StatusCode)
	}

	// First alternative (oauth2Auth, handled like a bearer token) satisfies the request on its own.
	req2, _ := http.NewRequest(http.MethodPost, s.URL+"/widgets/w1/favorite", nil)
	req2.Header.Set("Authorization", "Bearer sometoken")
	resp2, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusNoContent {
		t.Fatalf("expected 204 with an oauth2 bearer token present, got %d", resp2.StatusCode)
	}

	// Second alternative (apiKeyAuth) also satisfies the request on its own, without oauth2Auth.
	req3, _ := http.NewRequest(http.MethodPost, s.URL+"/widgets/w1/favorite", nil)
	req3.Header.Set("X-Api-Key", "secret")
	resp3, err := http.DefaultClient.Do(req3)
	if err != nil {
		t.Fatal(err)
	}
	defer resp3.Body.Close()
	if resp3.StatusCode != http.StatusNoContent {
		t.Fatalf("expected 204 with an X-Api-Key header present, got %d", resp3.StatusCode)
	}
}

func TestListPetsNotFoundPath(t *testing.T) {
	s := newTestServer(t)
	resp, err := http.Get(fmt.Sprintf("%s/pets/missing", s.URL))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected the fake handler's not-found ValidationError to map to 400, got %d", resp.StatusCode)
	}
}
