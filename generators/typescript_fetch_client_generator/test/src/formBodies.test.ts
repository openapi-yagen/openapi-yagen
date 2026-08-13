import { test } from "node:test";
import assert from "node:assert/strict";
import { PetsClient } from "../generated/apis/PetsClient.js";
import { createFetchStub } from "./support/fetchStub.js";

test("subscribeToPet sends the body as application/x-www-form-urlencoded", async () => {
  const { fetch, calls } = createFetchStub(() => ({ status: 204 }));
  await new PetsClient({ baseUrl: "https://example.test", fetch }).subscribeToPet("1", {
    body: { email: "me@example.com", notify: true },
  });
  assert.equal(calls[0]!.headers["content-type"], "application/x-www-form-urlencoded");
  const params = new URLSearchParams(calls[0]!.body as string);
  assert.equal(params.get("email"), "me@example.com");
  assert.equal(params.get("notify"), "true");
});

test("uploadPetPhoto sends the body as a native FormData with no Content-Type set", async () => {
  const { fetch, calls } = createFetchStub(() => ({ status: 204 }));
  const photo = new Blob(["raw-bytes"], { type: "image/jpeg" });
  await new PetsClient({ baseUrl: "https://example.test", fetch }).uploadPetPhoto("1", {
    body: { caption: "cute", photo },
  });
  // fetch itself sets Content-Type (with the multipart boundary) once it sees a FormData body -
  // the stub never applies that step, so its absence here just proves the generated code didn't
  // set one itself (which would omit the boundary and break a real request).
  assert.equal(calls[0]!.headers["content-type"], undefined);
  assert.ok(calls[0]!.body instanceof FormData);
  const body = calls[0]!.body as FormData;
  assert.equal(body.get("caption"), "cute");
  // FormData.append wraps a Blob value into a File (Node's WHATWG FormData implementation, same
  // as browsers) - not the same object anymore, so compare content/type instead of reference.
  const uploadedPhoto = body.get("photo") as Blob;
  assert.ok(uploadedPhoto instanceof Blob);
  assert.equal(uploadedPhoto.type, "image/jpeg");
  assert.equal(uploadedPhoto.size, photo.size);
});
