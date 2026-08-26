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

func (fakePetsHandler) ListPets(ctx context.Context, limit *int, tag *string, tags []string) (models.Pets, error) {
	return models.Pets{{Id: 1, Name: "Rex"}}, nil
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
	w.WriteField("photo", "binarydata")
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
	resp, err := http.PostForm(s.URL+"/pets/1/subscribe", form)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", resp.StatusCode)
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
