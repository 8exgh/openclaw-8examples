#!/usr/bin/env python3
"""Fill in the My Claw App Store Connect listing from the repo's metadata.

Idempotent: every step looks up what exists and creates/patches as needed,
so it can be re-run after a partial failure. Requires the app record to exist
(App Store Connect can't create apps via the API) and ASC_KEY_ID /
ASC_ISSUER_ID in the environment (see asc.py).

Steps (each also runnable alone):  info  version  rating  screenshots  review  build  submit  all
"""
import hashlib
import os
import sys
import time

import asc

BUNDLE_ID = "com.8examples.openclaw"
HERE = os.path.dirname(os.path.abspath(__file__))
IOS_DIR = os.path.dirname(HERE)
SCREENSHOT_DIR = os.path.join(IOS_DIR, "Screenshots", "iphone-6.9")
SITE = "https://8examples.com"

COPYRIGHT = "© 2026 8Examples"
SUBTITLE = "Talk to your OpenClaw assistant"
PROMO = ("Chat with your claw, share your location so it can help with what's near you, "
         "and set up its phone number, website, Telegram bot and Alexa skill.")
KEYWORDS = "openclaw,assistant,AI,claw,chat,phone,website,telegram,alexa,location,business,8examples"  # ≤100 chars
WHATS_NEW = "First release."
DESCRIPTION = """My Claw is the companion app for your managed OpenClaw assistant from 8Examples: the AI worker that answers your texts, makes your phone calls, keeps your website current and handles your paperwork.

Sign in with the same username and password you use for your claw's web chat. If you have more than one claw, they all show up.

CHAT WITH YOUR CLAW
One conversation per claw, right in the app. Ask it to check your messages, book an appointment, draft a reply or change your website. Replies arrive in the same thread, and your claw remembers what you talked about on the phone, on Telegram and on the web.

LET IT KNOW WHERE YOU ARE (OPTIONAL)
Say yes and your phone shares its location with your claw every five minutes, even in the background, so it can answer things like "what's open near me" or "text my ETA". Say no and it never asks again. Stop sharing at any time; the last position is forgotten.

YOUR WEBSITE
See your domain and your fusenv.com address, open the live site in Safari, and tell your claw what to change in plain words. Edits go live within a couple of minutes.

YOUR CLAW'S PHONE NUMBER
Call or text your claw like a person. Tips show you what to ask for: "check my SMS every 15 minutes", "phone the clinic and reserve the next appointment", "call me while I drive".

TELEGRAM AND ALEXA
Step-by-step instructions to give your claw a Telegram bot, and to enable the "My Claw" Alexa skill so every Echo in the house can talk to it.

REQUIRES A MANAGED OPENCLAW SUBSCRIPTION
My Claw only works with an assistant from 8examples.com/openclaw. The app itself is free.

PRIVACY
Your location is stored only if you say yes, only the most recent position is kept, and only your own claw can read it. Terms: 8examples.com/openclaw/terms. Privacy: 8examples.com/openclaw/privacy."""

REVIEW_NOTES = """My Claw is the companion app for a paid, managed AI assistant ("claw") sold at https://8examples.com/openclaw. Every customer gets one assistant running on our servers; this app lets them talk to it and configure it. There is nothing to buy in the app.

DEMO ACCOUNT (a live assistant reserved for review):
    Username: openclaw1
    Password: v6WwpzrfmBtdrm

Sign in on the first screen. The Claws tab opens a chat with the assistant; send any message ("what can you do?") and a reply appears within about 15 seconds. The Website, Phone and Connect tabs show that assistant's website address, phone number and set-up guides, each with the same chat underneath.

LOCATION: the Location tab asks whether the assistant may know where the user is. Tapping Yes records consent on our server and then requests iOS location permission (When In Use, then Always). While consent is on, the app posts the phone's coordinates to https://8examples.com every 5 minutes, including in the background (UIBackgroundModes: location), so the assistant can answer questions like "what's open near me". The user can stop at any time from the same tab, which revokes consent and discards the last position. Location is never used for advertising or shared with anyone but the user's own assistant. You can test with a simulated location; nothing else in the app depends on it.

Links: privacy https://8examples.com/openclaw/privacy, terms https://8examples.com/openclaw/terms, support https://8examples.com/contact. The Alexa page links to our published "My Claw" skill in the Amazon Alexa app; the Telegram page links to Telegram's BotFather."""

REVIEW_CONTACT = {
    "contactFirstName": os.environ.get("ASC_CONTACT_FIRST", "Sean"),
    "contactLastName": os.environ.get("ASC_CONTACT_LAST", "Bennett"),
    "contactPhone": os.environ.get("ASC_CONTACT_PHONE", ""),
    "contactEmail": os.environ.get("ASC_CONTACT_EMAIL", "sean@8examples.com"),
}

DEMO_USER = "openclaw1"
DEMO_PASS = "v6WwpzrfmBtdrm"


def log(*a):
    print(*a, flush=True)


# ---------- lookups ----------

def app():
    apps = asc.get("/v1/apps", **{"filter[bundleId]": BUNDLE_ID})["data"]
    if not apps:
        raise SystemExit(f"No App Store Connect app record for {BUNDLE_ID}. Create it in the website (My Apps → + → New App) and re-run.")
    return apps[0]


EDITABLE = ("PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED", "WAITING_FOR_REVIEW", "INVALID_BINARY")


def version(app_id):
    vs = asc.get(f"/v1/apps/{app_id}/appStoreVersions", **{"filter[platform]": "IOS", "limit": 5})["data"]
    editable = [v for v in vs if v["attributes"]["appStoreState"] in EDITABLE]
    if editable:
        return editable[0]
    log("  creating version 1.0")
    return asc.post("/v1/appStoreVersions", {"data": {"type": "appStoreVersions",
        "attributes": {"platform": "IOS", "versionString": "1.0", "copyright": COPYRIGHT},
        "relationships": {"app": {"data": {"type": "apps", "id": app_id}}}}})["data"]


def patch(kind, rid, attrs, relationships=None):
    body = {"data": {"type": kind, "id": rid, "attributes": attrs}}
    if relationships:
        body["data"]["relationships"] = relationships
    return asc.patch(f"/v1/{kind}/{rid}", body)["data"]


def app_info(a):
    infos = asc.get(f"/v1/apps/{a['id']}/appInfos")["data"]
    return next((i for i in infos if i["attributes"].get("appStoreState") in ("PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "READY_FOR_DISTRIBUTION", "METADATA_REJECTED")), infos[0])


# ---------- steps ----------

def step_info(a):
    log("== app info")
    info = app_info(a)
    asc.patch(f"/v1/appInfos/{info['id']}", {"data": {"type": "appInfos", "id": info["id"], "relationships": {
        "primaryCategory": {"data": {"type": "appCategories", "id": "PRODUCTIVITY"}},
        "secondaryCategory": {"data": {"type": "appCategories", "id": "BUSINESS"}},
    }}})
    log("  categories: Productivity / Business")
    locs = asc.get(f"/v1/appInfos/{info['id']}/appInfoLocalizations")["data"]
    attrs = {"subtitle": SUBTITLE, "privacyPolicyUrl": f"{SITE}/openclaw/privacy"}
    en = next((l for l in locs if l["attributes"]["locale"] == "en-US"), None)
    if en:
        patch("appInfoLocalizations", en["id"], attrs)
    else:
        asc.post("/v1/appInfoLocalizations", {"data": {"type": "appInfoLocalizations", "attributes": {"locale": "en-US", **attrs},
                 "relationships": {"appInfo": {"data": {"type": "appInfos", "id": info["id"]}}}}})
    log("  subtitle + privacy URL set")
    try:
        patch("apps", a["id"], {"contentRightsDeclaration": "DOES_NOT_USE_THIRD_PARTY_CONTENT"})
        log("  content rights: no third-party content")
    except SystemExit as e:
        log("  (content rights not set:", str(e).splitlines()[0], ")")
    # Custom EULA: the OpenClaw terms from the website.
    try:
        eulas = asc.get(f"/v1/apps/{a['id']}/endUserLicenseAgreement").get("data")
    except SystemExit:
        eulas = None
    if not eulas:
        log("  (EULA left as Apple's standard; terms are linked in the description and review notes)")


def step_version(a):
    log("== version")
    v = version(a["id"])
    patch("appStoreVersions", v["id"], {"copyright": COPYRIGHT, "releaseType": "AFTER_APPROVAL"})
    locs = asc.get(f"/v1/appStoreVersions/{v['id']}/appStoreVersionLocalizations")["data"]
    attrs = {"description": DESCRIPTION, "keywords": KEYWORDS, "promotionalText": PROMO,
             "supportUrl": f"{SITE}/contact", "marketingUrl": f"{SITE}/openclaw"}
    if v["attributes"]["versionString"] != "1.0":
        attrs["whatsNew"] = WHATS_NEW
    en = next((l for l in locs if l["attributes"]["locale"] == "en-US"), None)
    if en:
        patch("appStoreVersionLocalizations", en["id"], attrs)
    else:
        asc.post("/v1/appStoreVersionLocalizations", {"data": {"type": "appStoreVersionLocalizations", "attributes": {"locale": "en-US", **attrs},
                 "relationships": {"appStoreVersion": {"data": {"type": "appStoreVersions", "id": v["id"]}}}}})
    log(f"  version {v['attributes']['versionString']} text set")
    return v


def step_rating(a):
    log("== age rating")
    info = app_info(a)
    decl = asc.get(f"/v1/appInfos/{info['id']}/ageRatingDeclaration")["data"]
    attrs = {
        "alcoholTobaccoOrDrugUseOrReferences": "NONE", "contests": "NONE", "gamblingSimulated": "NONE",
        "horrorOrFearThemes": "NONE", "matureOrSuggestiveThemes": "NONE", "profanityOrCrudeHumor": "NONE",
        "sexualContentGraphicAndNudity": "NONE", "sexualContentOrNudity": "NONE",
        "violenceCartoonOrFantasy": "NONE", "violenceRealistic": "NONE", "violenceRealisticProlongedGraphicOrSadistic": "NONE",
        "medicalOrTreatmentInformation": "NONE", "gunsOrOtherWeapons": "NONE",
        "gambling": False, "unrestrictedWebAccess": False, "lootBox": False,
        "advertising": False, "ageAssurance": False, "healthOrWellnessTopics": False,
        # The chat is with the user's own AI assistant, not other people.
        "messagingAndChat": False, "parentalControls": False, "userGeneratedContent": False,
        "socialMedia": False, "socialMediaAgeRestricted": False,
        "koreaAgeRatingOverride": "NONE", "ageRatingOverrideV2": "NONE",
    }
    while attrs:
        try:
            patch("ageRatingDeclarations", decl["id"], attrs)
            break
        except SystemExit as e:
            msg = str(e)
            dropped = [k for k in list(attrs) if f"'{k}'" in msg or f'"{k}"' in msg or f"/{k}" in msg]
            if not dropped:
                raise
            for k in dropped:
                attrs.pop(k)
            log("  (dropped unsupported:", ", ".join(dropped), ")")
    log("  declared: nothing sensitive (4+)")


def md5(path):
    h = hashlib.md5()
    with open(path, "rb") as f:
        h.update(f.read())
    return h.hexdigest()


def upload_asset(create_path, create_type, rel_name, rel_type, rel_id, path):
    size = os.path.getsize(path)
    res = asc.post(create_path, {"data": {"type": create_type, "attributes": {"fileName": os.path.basename(path), "fileSize": size},
                                          "relationships": {rel_name: {"data": {"type": rel_type, "id": rel_id}}}}})["data"]
    with open(path, "rb") as f:
        blob = f.read()
    import requests
    for op in res["attributes"]["uploadOperations"]:
        chunk = blob[op["offset"]: op["offset"] + op["length"]]
        headers = {h["name"]: h["value"] for h in op.get("requestHeaders", [])}
        r = requests.request(op["method"], op["url"], data=chunk, headers=headers, timeout=300)
        if r.status_code >= 400:
            raise SystemExit(f"upload chunk → {r.status_code} {r.text[:300]}")
    asc.patch(f"/v1/{create_type}/{res['id']}", {"data": {"type": create_type, "id": res["id"],
              "attributes": {"uploaded": True, "sourceFileChecksum": md5(path)}}})
    return res["id"]


def step_screenshots(a):
    log("== screenshots")
    v = version(a["id"])
    locs = asc.get(f"/v1/appStoreVersions/{v['id']}/appStoreVersionLocalizations")["data"]
    en = next(l for l in locs if l["attributes"]["locale"] == "en-US")
    sets = asc.get(f"/v1/appStoreVersionLocalizations/{en['id']}/appScreenshotSets")["data"]
    display = "APP_IPHONE_67"
    st = next((s for s in sets if s["attributes"]["screenshotDisplayType"] == display), None)
    if not st:
        st = asc.post("/v1/appScreenshotSets", {"data": {"type": "appScreenshotSets", "attributes": {"screenshotDisplayType": display},
                      "relationships": {"appStoreVersionLocalization": {"data": {"type": "appStoreVersionLocalizations", "id": en["id"]}}}}})["data"]
    existing = {s["attributes"]["fileName"]: s for s in asc.get(f"/v1/appScreenshotSets/{st['id']}/appScreenshots")["data"]}
    for f in sorted(f for f in os.listdir(SCREENSHOT_DIR) if f.endswith(".png")):
        have = existing.get(f)
        if have:
            if have["attributes"].get("sourceFileChecksum") == md5(os.path.join(SCREENSHOT_DIR, f)):
                log("  have", f)
                continue
            asc.delete(f"/v1/appScreenshots/{have['id']}")
            log("  replacing", f)
        upload_asset("/v1/appScreenshots", "appScreenshots", "appScreenshotSet", "appScreenshotSets", st["id"], os.path.join(SCREENSHOT_DIR, f))
        log("  uploaded", f)


def step_review(a):
    log("== review details")
    v = version(a["id"])
    attrs = {k: val for k, val in REVIEW_CONTACT.items() if val}
    attrs.update({"demoAccountRequired": True, "demoAccountName": DEMO_USER,
                  "demoAccountPassword": DEMO_PASS, "notes": REVIEW_NOTES})
    d = None
    try:
        d = asc.get(f"/v1/appStoreVersions/{v['id']}/appStoreReviewDetail").get("data")
    except SystemExit:
        pass
    if d:
        patch("appStoreReviewDetails", d["id"], attrs)
    else:
        asc.post("/v1/appStoreReviewDetails", {"data": {"type": "appStoreReviewDetails", "attributes": attrs,
                 "relationships": {"appStoreVersion": {"data": {"type": "appStoreVersions", "id": v["id"]}}}}})
    log("  review notes + demo account set")


def step_build(a):
    log("== build")
    v = version(a["id"])
    for _ in range(60):
        builds = asc.get("/v1/builds", **{"filter[app]": a["id"], "sort": "-uploadedDate", "limit": 1})["data"]
        if builds:
            b = builds[0]
            st = b["attributes"]["processingState"]
            log("  latest build", b["attributes"]["version"], st)
            if st == "VALID":
                asc.patch(f"/v1/appStoreVersions/{v['id']}/relationships/build", {"data": {"type": "builds", "id": b["id"]}})
                log("  attached to version", v["attributes"]["versionString"])
                return
            if st in ("FAILED", "INVALID"):
                raise SystemExit("build processing failed")
        time.sleep(30)
    raise SystemExit("gave up waiting for a processed build")


def step_submit(a):
    log("== submit for review")
    v = version(a["id"])
    subs = asc.get("/v1/reviewSubmissions", **{"filter[app]": a["id"], "filter[state]": "READY_FOR_REVIEW,WAITING_FOR_REVIEW,IN_REVIEW,UNRESOLVED_ISSUES", "limit": 5})["data"]
    sub = subs[0] if subs else None
    if not sub:
        sub = asc.post("/v1/reviewSubmissions", {"data": {"type": "reviewSubmissions", "attributes": {"platform": "IOS"},
                       "relationships": {"app": {"data": {"type": "apps", "id": a["id"]}}}}})["data"]
        log("  created review submission")
    items = asc.get(f"/v1/reviewSubmissions/{sub['id']}/items")["data"]
    if not items:
        asc.post("/v1/reviewSubmissionItems", {"data": {"type": "reviewSubmissionItems",
                 "relationships": {"reviewSubmission": {"data": {"type": "reviewSubmissions", "id": sub["id"]}},
                                   "appStoreVersion": {"data": {"type": "appStoreVersions", "id": v["id"]}}}}})
        log("  added version", v["attributes"]["versionString"])
    if sub["attributes"]["state"] == "READY_FOR_REVIEW":
        patch("reviewSubmissions", sub["id"], {"submitted": True})
        log("  submitted")
    else:
        log("  state", sub["attributes"]["state"])


STEPS = {"info": step_info, "version": step_version, "rating": step_rating, "screenshots": step_screenshots,
         "review": step_review, "build": step_build, "submit": step_submit}

if __name__ == "__main__":
    which = sys.argv[1:] or ["all"]
    a = app()
    log("app", a["id"], a["attributes"]["name"], a["attributes"]["bundleId"])
    for name in (list(STEPS) if which == ["all"] else which):
        STEPS[name](a)
    log("done")
