// Inaya Business OS connector for Microsoft Power BI (Power Query custom connector).
// SOW INAYA-BOS-POWERBI-SOW-2026-V1. Read-only. Signs in with OAuth 2.0 + PKCE (no shared or stored secret), then reads the
// Inaya Analytics API v1. Everything a user sees is limited by their Inaya role, departments and branches on the server.
//
//   Inaya.Contents([From, To])              navigation table of every dataset the signed-in person may read
//   Inaya.Dataset(name, From, To)           one dataset for a date range: use it with RangeStart/RangeEnd for incremental refresh
//
// Build: node scripts/powerbi/build.mjs  ->  public/downloads/powerbi/Inaya.mez
// Parameters are marked DataSource.Path = false: one Inaya sign-in covers every dataset and date range, and date/time values
// are not allowed in a data source path (Power BI silently drops a connector whose data source function breaks that rule).
section Inaya;

BaseUrl = "https://www.inayanetwork.com";
ClientId = "inaya-powerbi";
RedirectUri = "https://oauth.powerbi.com/views/oauthredirect.html";
MaxDaysPerRequest = 360;
PageSize = 5000;

[DataSource.Kind = "Inaya", Publish = "Inaya.Publish"]
shared Inaya.Contents = Value.ReplaceType(NavigationTable, ContentsType);

[DataSource.Kind = "Inaya"]
shared Inaya.Dataset = Value.ReplaceType(DatasetTable, DatasetType);

ContentsType = type function (
    optional From as (type nullable date meta [DataSource.Path = false, Documentation.FieldCaption = "From date", Documentation.FieldDescription = "Earliest date to load for dated datasets. Default: two years ago.", Documentation.SampleValues = {"2025-01-01"}]),
    optional To as (type nullable date meta [DataSource.Path = false, Documentation.FieldCaption = "To date", Documentation.FieldDescription = "Latest date to load. Default: today."])
  ) as table meta [
    Documentation.Name = "Inaya Business OS",
    Documentation.LongDescription = "Read-only access to your company's Inaya Business OS data for Power BI reports. You only see what your role, departments and branches allow in Inaya."
  ];

DatasetType = type function (
    Name as (type text meta [DataSource.Path = false, Documentation.FieldCaption = "Dataset", Documentation.SampleValues = {"sales_lines", "invoices"}]),
    From as (type datetime meta [DataSource.Path = false, Documentation.FieldCaption = "From (RangeStart)"]),
    To as (type datetime meta [DataSource.Path = false, Documentation.FieldCaption = "To (RangeEnd)"])
  ) as table meta [Documentation.Name = "Inaya dataset for a date range (incremental refresh)"];

// ---------------------------------------------------------------------------------------------- API calls
GetJson = (relativePath as text, optional query as nullable record) as record =>
    let
        Response = Web.Contents(BaseUrl, [
            RelativePath = relativePath,
            Query = if query = null then [] else query,
            Headers = [Accept = "application/json", #"X-Inaya-Client" = "powerbi-connector/1.0"],
            ManualStatusHandling = {400, 403, 404, 429}
        ]),
        Status = Value.Metadata(Response)[Response.Status],
        Body = Json.Document(Response),
        Result = if Status >= 400 then
                error Error.Record("Inaya: " & (if Record.HasFields(Body, "error_description") then Body[error_description] else "Request failed"), Text.From(Status))
            else Body
    in
        Result;

Catalogue = () as record => GetJson("api/analytics/v1/datasets");

IsoText = (d as any) as text =>
    let dt = if Value.Is(d, type date) then DateTime.From(d) else if Value.Is(d, type datetimezone) then DateTimeZone.RemoveZone(DateTimeZone.ToUtc(d)) else DateTime.From(d)
    in DateTime.ToText(dt, [Format = "yyyy-MM-ddTHH:mm:ss", Culture = "en-US"]) & "Z";

// Every page of one dataset inside one window (the API pages with an opaque cursor).
Pages = (name as text, window as nullable record) as list =>
    let
        Base = [limit = Text.From(PageSize)] & (if window = null then [] else [from = window[from], to = window[to]]),
        All = List.Generate(
            () => GetJson("api/analytics/v1/datasets/" & name, Base),
            each _ <> null,
            each if _[next] = null then null else GetJson("api/analytics/v1/datasets/" & name, Base & [cursor = _[next]]),
            each _[rows])
    in
        List.Combine(All);

// Splits [from, to) into windows the API accepts (it allows at most 366 days per request).
Windows = (from as datetime, to as datetime) as list =>
    List.Generate(
        () => from,
        each _ < to,
        each _ + #duration(MaxDaysPerRequest, 0, 0, 0),
        each [from = IsoText(_), to = IsoText(List.Min({_ + #duration(MaxDaysPerRequest, 0, 0, 0), to}))]);

TypeOf = (t as text) as type =>
    if t = "money" or t = "number" then type number
    else if t = "integer" then Int64.Type
    else if t = "boolean" then type logical
    else if t = "datetime" then type datetimezone
    else if t = "date" then type date
    else type text;

Convert = (t as text) as function =>
    if t = "datetime" then (v) => if v = null then null else DateTimeZone.FromText(v)
    else if t = "date" then (v) => if v = null then null else Date.From(DateTimeZone.FromText(v))
    else if t = "money" or t = "number" or t = "integer" then (v) => if v = null then null else Number.From(v)
    else if t = "boolean" then (v) => v
    else (v) => if v = null then null else Text.From(v);

// Rows -> a typed table with the documented columns, in the documented order (also when there are no rows).
ToTable = (rows as list, fields as list) as table =>
    let
        Names = List.Transform(fields, each _[name]),
        Raw = if List.IsEmpty(rows) then #table(Names, {}) else Table.FromRecords(rows, Names, MissingField.UseNull),
        Converted = Table.TransformColumns(Raw, List.Transform(fields, (f) => {f[name], Convert(f[type])})),
        Typed = Table.TransformColumnTypes(Converted, List.Transform(fields, (f) => {f[name], TypeOf(f[type])}))
    in
        Typed;

LoadDataset = (ds as record, from as datetime, to as datetime) as table =>
    let
        Rows = if ds[incremental] then List.Combine(List.Transform(Windows(from, to), (w) => Pages(ds[name], w))) else Pages(ds[name], null)
    in
        ToTable(Rows, ds[fields]);

DatasetTable = (Name as text, From as datetime, To as datetime) as table =>
    let
        Cat = Catalogue(),
        Matches = List.Select(Cat[datasets], each _[name] = Name),
        Ds = if List.IsEmpty(Matches) then error Error.Record("Inaya: unknown dataset " & Name) else Matches{0},
        // A dataset this person's role can't read loads empty (same columns), so one locked table never fails a whole report refresh.
        Result = if not Ds[allowed] then ToTable({}, Ds[fields]) else LoadDataset(Ds, From, To)
    in
        Result;

NavigationTable = (optional From as nullable date, optional To as nullable date) as table =>
    let
        Cat = Catalogue(),
        Today = DateTime.Date(DateTime.FixedLocalNow()),
        FromDt = DateTime.From(if From = null then Date.AddYears(Today, -2) else From),
        ToDt = DateTime.From(Date.AddDays(if To = null then Today else To, 1)),
        Allowed = List.Select(Cat[datasets], each _[allowed]),
        Rows = List.Transform(Allowed, (ds) => {ds[title], ds[name], LoadDataset(ds, FromDt, ToDt), "Table", "Table", true}),
        Source = #table({"Name", "Key", "Data", "ItemKind", "ItemName", "IsLeaf"}, Rows),
        Nav = Table.ToNavigationTable(Source, {"Key"}, "Name", "Data", "ItemKind", "ItemName", "IsLeaf")
    in
        Nav;

// ---------------------------------------------------------------------------------------------- authentication
Inaya = [
    TestConnection = (dataSourcePath) => {"Inaya.Contents"},
    Authentication = [
        OAuth = [
            StartLogin = StartLogin,
            FinishLogin = FinishLogin,
            Refresh = Refresh,
            Logout = Logout,
            Label = "Inaya account"
        ]
    ],
    Label = "Inaya Business OS"
];

Base64Url = (b as binary) as text =>
    Text.Replace(Text.Replace(Text.Replace(Binary.ToText(b, BinaryEncoding.Base64), "+", "-"), "/", "_"), "=", "");

StartLogin = (resourceUrl, state, display) =>
    let
        Verifier = Text.Remove(Text.NewGuid() & Text.NewGuid(), "-"),
        Challenge = Base64Url(Crypto.CreateHash(CryptoAlgorithm.SHA256, Text.ToBinary(Verifier, TextEncoding.Ascii))),
        Url = BaseUrl & "/business/powerbi-authorize?" & Uri.BuildQueryString([
            response_type = "code", client_id = ClientId, redirect_uri = RedirectUri, state = state,
            code_challenge = Challenge, code_challenge_method = "S256"])
    in
        [LoginUri = Url, CallbackUri = RedirectUri, WindowHeight = 760, WindowWidth = 520, Context = Verifier];

FinishLogin = (context, callbackUri, state) =>
    let
        Parts = Uri.Parts(callbackUri)[Query],
        Result = if Record.HasFields(Parts, "error") then
                error Error.Record(Parts[error], if Record.HasFields(Parts, "error_description") then Parts[error_description] else "Sign-in was cancelled.")
            else TokenRequest([grant_type = "authorization_code", code = Parts[code], redirect_uri = RedirectUri, code_verifier = context])
    in
        Result;

Refresh = (resourceUrl, refresh_token) => TokenRequest([grant_type = "refresh_token", refresh_token = refresh_token]);

Logout = (token) => BaseUrl & "/business";

TokenRequest = (fields as record) =>
    let
        Response = Web.Contents(BaseUrl & "/api/analytics/oauth/token", [
            Content = Text.ToBinary(Uri.BuildQueryString(fields & [client_id = ClientId])),
            Headers = [#"Content-Type" = "application/x-www-form-urlencoded", Accept = "application/json"],
            ManualStatusHandling = {400, 401, 403, 429}
        ]),
        Body = Json.Document(Response),
        Result = if Record.HasFields(Body, "error") then
                error Error.Record(Body[error], if Record.HasFields(Body, "error_description") then Body[error_description] else "Inaya sign-in failed.")
            else Body
    in
        Result;

// ---------------------------------------------------------------------------------------------- Get Data dialog
Inaya.Publish = [
    Beta = true,
    Category = "Online Services",
    ButtonText = {"Inaya Business OS", "Read your company's Inaya Business OS data (sales, finance, stock, purchasing, operations, HR)."},
    LearnMoreUrl = "https://www.inayanetwork.com/docs/products/power-bi",
    SourceImage = Inaya.Icons,
    SourceTypeImage = Inaya.Icons
];

Inaya.Icons = [
    Icon16 = {Extension.Contents("Inaya16.png"), Extension.Contents("Inaya20.png"), Extension.Contents("Inaya24.png"), Extension.Contents("Inaya32.png")},
    Icon32 = {Extension.Contents("Inaya32.png"), Extension.Contents("Inaya40.png"), Extension.Contents("Inaya48.png"), Extension.Contents("Inaya64.png")}
];

// Standard helper from the Power Query SDK samples.
Table.ToNavigationTable = (table as table, keyColumns as list, nameColumn as text, dataColumn as text, itemKindColumn as text, itemNameColumn as text, isLeafColumn as text) as table =>
    let
        tableType = Value.Type(table),
        newTableType = Type.AddTableKey(tableType, keyColumns, true) meta [
            NavigationTable.NameColumn = nameColumn, NavigationTable.DataColumn = dataColumn, NavigationTable.ItemKindColumn = itemKindColumn,
            Preview.DelayColumn = itemNameColumn, NavigationTable.IsLeafColumn = isLeafColumn],
        navigationTable = Value.ReplaceType(table, newTableType)
    in
        navigationTable;
