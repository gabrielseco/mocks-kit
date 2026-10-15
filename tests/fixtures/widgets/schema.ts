// What openapi-typescript would generate from openapi.json, trimmed to the
// `operations` the handler types read.
export interface components {
  schemas: {
    Error: { error: string };
    LoginRequest: { code: string };
    User: { email: string };
    Widget: {
      slug: string;
      name: string;
      price: number;
      /** Format: date */
      created_on: string;
      note?: string | null;
    };
    WidgetInput: { name: string; price: number };
  };
}

type Schemas = components['schemas'];
type Json<T> = { headers: { [name: string]: unknown }; content: { 'application/json': T } };
type Empty = { headers: { [name: string]: unknown }; content?: never };
type NoParameters = { query?: never; header?: never; path?: never; cookie?: never };

export interface operations {
  login: {
    parameters: NoParameters;
    requestBody?: { content: { 'application/json': Schemas['LoginRequest'] } };
    responses: { 200: Json<Schemas['User']>; 401: Json<Schemas['Error']> };
  };
  logout: {
    parameters: NoParameters;
    requestBody?: never;
    responses: { 204: Empty };
  };
  getHealth: {
    parameters: NoParameters;
    requestBody?: never;
    responses: { 200: Json<{ status: 'ok' }> };
  };
  getWidget: {
    parameters: { query?: never; header?: never; path: { slug: string }; cookie?: never };
    requestBody?: never;
    responses: { 200: Json<Schemas['Widget']>; 404: Empty };
  };
  deleteWidget: {
    parameters: { query?: never; header?: never; path: { slug: string }; cookie?: never };
    requestBody?: never;
    responses: { 204: Empty; 404: Empty };
  };
  getFeaturedWidget: {
    parameters: NoParameters;
    requestBody?: never;
    responses: { 200: Json<Schemas['Widget']> };
  };
  listWidgets: {
    parameters: { query?: { limit?: number }; header?: never; path?: never; cookie?: never };
    requestBody?: never;
    responses: { 200: Json<Schemas['Widget'][]> };
  };
  createWidget: {
    parameters: NoParameters;
    requestBody: { content: { 'application/json': Schemas['WidgetInput'] } };
    responses: { 201: Json<Schemas['Widget']>; 422: Json<Schemas['Error']> };
  };
  listGadgets: {
    parameters: NoParameters;
    requestBody?: never;
    responses: { 200: Json<string[]> };
  };
}

export type Widget = Schemas['Widget'];
