require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const twilio = require("twilio");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Clients ---
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ============================================================
// HELPER: Send a WhatsApp/SMS message back to a user
// ============================================================
async function sendReply(toNumber, message) {
  const useWhatsApp = process.env.USE_WHATSAPP === "true";
  await twilioClient.messages.create({
    body: message,
    from: useWhatsApp
      ? `whatsapp:${process.env.TWILIO_PHONE_NUMBER}`
      : process.env.TWILIO_PHONE_NUMBER,
    to: useWhatsApp ? `whatsapp:${toNumber}` : toNumber,
  });
}

// ============================================================
// TWILIO INCOMING MESSAGE WEBHOOK (WhatsApp + SMS)
// Responds immediately, processes large lists in background
// ============================================================
app.post("/api/sms/incoming", async (req, res) => {
  const rawFrom = req.body.From || "";
  const fromNumber = rawFrom.replace("whatsapp:", "");
  const body = (req.body.Body || "").trim();
  const isWhatsApp = rawFrom.startsWith("whatsapp:");
  const twiml = new twilio.twiml.MessagingResponse();

  try {
    // 1. Check if sender is authorized
    const { data: authUser } = await supabase
      .from("authorized_users")
      .select("*")
      .eq("phone_number", fromNumber)
      .single();

    if (!authUser) {
      twiml.message("Sorry, you're not authorized to add guests to any event.");
      res.type("text/xml").send(twiml.toString());
      return;
    }

    // 2. Check for pending confirmation (YES/NO) or event clarification
    const { data: pending } = await supabase
      .from("pending_submissions")
      .select("*")
      .eq("phone_number", fromNumber)
      .in("status", ["pending", "awaiting_event"])
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    // Handle YES to confirm guest list (add or remove)
    if (pending && pending.status === "pending" && body.toUpperCase() === "YES") {
      twiml.message("⏳ Processing...");
      res.type("text/xml").send(twiml.toString());

      try {
        const parsed = JSON.parse(pending.parsed_data);

        if (parsed.action === "remove") {
          for (const guestId of parsed.guest_ids) {
            await supabase.from("guests").delete().eq("id", guestId);
          }
          await supabase
            .from("pending_submissions")
            .update({ status: "confirmed" })
            .eq("id", pending.id);
          await sendReply(
            fromNumber,
            `✅ Done! Removed ${parsed.guest_ids.length} guests from ${parsed.event_name}.`
          );
        } else {
          await addGuestsToEvent(parsed.event_id, parsed.guests);
          await supabase
            .from("pending_submissions")
            .update({ status: "confirmed" })
            .eq("id", pending.id);
          const count = parsed.guests.reduce(
            (sum, g) => sum + 1 + (g.plus_count || 0),
            0
          );
          await sendReply(fromNumber, `✅ Done! Added ${count} guests to ${parsed.event_name}.`);
        }
      } catch (bgErr) {
        console.error("Background YES processing error:", bgErr);
        await sendReply(fromNumber, "❌ Something went wrong. Please try sending your list again.");
      }
      return;
    }

    // Handle NO to cancel
    if (pending && pending.status === "pending" && body.toUpperCase() === "NO") {
      await supabase
        .from("pending_submissions")
        .update({ status: "cancelled" })
        .eq("id", pending.id);
      twiml.message("❌ Cancelled. Send your list again when ready.");
      res.type("text/xml").send(twiml.toString());
      return;
    }

    // Handle event clarification reply (user sent back an event name)
    if (pending && pending.status === "awaiting_event") {
      twiml.message("⏳ Processing your request... I'll send a confirmation shortly.");
      res.type("text/xml").send(twiml.toString());

      // Update status so it doesn't get picked up again
      await supabase
        .from("pending_submissions")
        .update({ status: "processing" })
        .eq("id", pending.id);

      const pendingData = JSON.parse(pending.parsed_data);

      if (pendingData.action === "remove") {
        // Re-process as removal with event name prepended
        const namesOnly = pending.raw_text.replace(/^remove\s*/i, "").trim();
        const combinedText = "remove " + body + "\n" + namesOnly;
        processRemovalInBackground(fromNumber, combinedText).catch((err) => {
          console.error("Removal processing error:", err);
          sendReply(fromNumber, "❌ Something went wrong. Please try again.").catch(console.error);
        });
      } else {
        // Re-process with the event name prepended to the original text
        const originalText = pending.raw_text;
        const combinedText = body + "\n" + originalText;
        processGuestListInBackground(fromNumber, combinedText, pending.id).catch((err) => {
          console.error("Background processing error:", err);
          sendReply(fromNumber, "❌ Something went wrong processing your list. Please try again.").catch(console.error);
        });
      }
      return;
    }

    // 3. Check for remove command
    if (body.toLowerCase().startsWith("remove")) {
      twiml.message("⏳ Processing removal request...");
      res.type("text/xml").send(twiml.toString());
      processRemovalInBackground(fromNumber, body).catch((err) => {
        console.error("Removal processing error:", err);
        sendReply(fromNumber, "❌ Something went wrong. Please try again.").catch(console.error);
      });
      return;
    }

    // 4. For new guest lists: respond immediately, parse in background
    twiml.message("⏳ Processing your guest list... I'll send a confirmation shortly.");
    res.type("text/xml").send(twiml.toString());

    processGuestListInBackground(fromNumber, body, null).catch((err) => {
      console.error("Background processing error:", err);
      sendReply(fromNumber, "❌ Something went wrong processing your list. Please try again.").catch(console.error);
    });

  } catch (err) {
    console.error("SMS webhook error:", err);
    twiml.message("Something went wrong. Please try again.");
    res.type("text/xml").send(twiml.toString());
  }
});

// ============================================================
// BACKGROUND GUEST LIST PROCESSING
// ============================================================
async function processGuestListInBackground(fromNumber, body, existingSubmissionId) {
  // 1. Get active events
  const { data: events } = await supabase
    .from("events")
    .select("*")
    .eq("is_active", true)
    .order("created_at", { ascending: false });

  if (!events || events.length === 0) {
    await sendReply(fromNumber, "No active events found. Create an event first in the admin dashboard.");
    return;
  }

  // 2. Count names to decide if we need to chunk
  const lines = body.split("\n").filter((l) => l.trim().length > 0);
  const nameCount = lines.length;

  let parseResult;

  if (nameCount > 30) {
    parseResult = await parseLargeListWithClaude(body, events);
  } else {
    parseResult = await parseNamesWithClaude(body, events);
  }

  // 3. If clarification needed, save the raw text and ask
  if (parseResult.needs_clarification) {
    // Clean up old submission if it exists
    if (existingSubmissionId) {
      await supabase
        .from("pending_submissions")
        .update({ status: "cancelled" })
        .eq("id", existingSubmissionId);
    }

    // Save with "awaiting_event" status so we remember the names
    await supabase.from("pending_submissions").insert({
      phone_number: fromNumber,
      raw_text: body,
      parsed_data: JSON.stringify({ awaiting_event: true }),
      status: "awaiting_event",
    });

    await sendReply(fromNumber, parseResult.clarification_message);
    return;
  }

  // 4. Clean up old submission if this was a re-process
  if (existingSubmissionId) {
    await supabase
      .from("pending_submissions")
      .update({ status: "cancelled" })
      .eq("id", existingSubmissionId);
  }

  // 5. Store as pending and send confirmation
  const confirmationMsg = formatConfirmation(
    parseResult.event_name,
    parseResult.guests
  );

  await supabase.from("pending_submissions").insert({
    phone_number: fromNumber,
    raw_text: body,
    parsed_data: JSON.stringify({
      event_id: parseResult.event_id,
      event_name: parseResult.event_name,
      guests: parseResult.guests,
    }),
    status: "pending",
  });

  await sendReply(fromNumber, confirmationMsg + "\n\nReply YES to confirm or NO to cancel.");
}

// ============================================================
// LARGE LIST PARSER (chunks names for Claude)
// ============================================================
async function parseLargeListWithClaude(messageBody, activeEvents) {
  const lines = messageBody.split("\n").filter((l) => l.trim().length > 0);

  // First line might be the event name — let Claude figure that out with just the first few lines
  const headerCheck = await parseNamesWithClaude(
    lines.slice(0, 5).join("\n"),
    activeEvents
  );

  const eventId = headerCheck.event_id;
  const eventName = headerCheck.event_name;

  if (headerCheck.needs_clarification) {
    return headerCheck;
  }

  // Now process all names in chunks of 25
  const allGuests = [];
  // Skip first line if it was used as event name
  const nameLines = headerCheck.guests.length < 5
    ? lines.slice(1)
    : lines;

  const chunkSize = 25;
  for (let i = 0; i < nameLines.length; i += chunkSize) {
    const chunk = nameLines.slice(i, i + chunkSize).join("\n");
    const chunkPrompt = `${eventName}\n${chunk}`;
    const chunkResult = await parseNamesWithClaude(chunkPrompt, activeEvents);
    if (chunkResult.guests) {
      allGuests.push(...chunkResult.guests);
    }
  }

  // Add back any guests from the header check that were real names
  // (in case the first parse included some names along with event detection)
  if (headerCheck.guests.length > 0 && headerCheck.guests.length < 5) {
    allGuests.unshift(...headerCheck.guests);
  }

  return {
    needs_clarification: false,
    event_id: eventId,
    event_name: eventName,
    guests: allGuests,
  };
}

// ============================================================
// CLAUDE NAME PARSING
// ============================================================
async function parseNamesWithClaude(messageBody, activeEvents) {
  const eventList = activeEvents
    .map((e) => `- "${e.name}" (id: ${e.id})`)
    .join("\n");

  const prompt = `You are a guest list parser for events. Parse the following text message into structured guest data.

Active events:
${eventList}

Rules:
1. The FIRST LINE may be an event name. Match it fuzzily to active events (e.g., "rooftop" matches "Rooftop Party 2/14"). If no event name is detected and there's only one active event, use that event.
2. Each subsequent line is typically ONE person's name. Parse intelligently:
   - "John Smith" = one person named John Smith
   - "Madonna" = one person named Madonna  
   - "john" on one line, then "sarah" on next line = TWO separate people (first names only)
   - "Mary Jane Watson" = one person with that full name
   - If a line has "+2" or "plus 2" or similar, that's the party size (plus-ones)
   - Tags in parentheses like (VIP) or notes after a dash like "- comp drinks" are notes/tags
3. Clean up capitalization (title case names)
4. If multiple active events and no event is specified or matched, set needs_clarification to true

Respond ONLY with valid JSON, no markdown backticks:
{
  "needs_clarification": false,
  "clarification_message": "",
  "event_id": "uuid-here",
  "event_name": "Event Name",
  "guests": [
    {
      "name": "John Smith",
      "plus_count": 2,
      "tags": ["VIP"],
      "notes": "comp drinks"
    }
  ]
}

Text message to parse:
"""
${messageBody}
"""`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content[0].text.trim();
  // Strip any accidental markdown fences
  const clean = text.replace(/```json\n?|```\n?/g, "").trim();
  return JSON.parse(clean);
}

// ============================================================
// FORMAT CONFIRMATION MESSAGE
// ============================================================
function formatConfirmation(eventName, guests) {
  let msg = `📋 Adding to "${eventName}":\n`;
  guests.forEach((g, i) => {
    let line = `${i + 1}. ${g.name}`;
    if (g.plus_count > 0) {
      const plusNames = [];
      for (let j = 1; j <= g.plus_count; j++) {
        plusNames.push(`${g.name} - Guest ${j}`);
      }
      line += ` (+${g.plus_count}): ${plusNames.join(", ")}`;
    }
    if (g.tags && g.tags.length > 0) line += ` [${g.tags.join(", ")}]`;
    if (g.notes) line += ` — ${g.notes}`;
    msg += line + "\n";
  });
  const total = guests.reduce((s, g) => s + 1 + (g.plus_count || 0), 0);
  msg += `\nTotal: ${total} guests`;
  return msg;
}

// ============================================================
// ADD GUESTS TO EVENT
// ============================================================
async function addGuestsToEvent(eventId, guests) {
  const rows = [];
  for (const g of guests) {
    // Check for fuzzy duplicates
    const isDuplicate = await checkDuplicate(eventId, g.name);
    rows.push({
      event_id: eventId,
      name: g.name,
      is_primary: true,
      primary_guest_name: null,
      tags: g.tags || [],
      notes: g.notes || null,
      is_vip: (g.tags || []).map((t) => t.toLowerCase()).includes("vip"),
      is_checked_in: false,
      is_duplicate_flag: isDuplicate,
    });
    // Add plus-ones
    for (let j = 1; j <= (g.plus_count || 0); j++) {
      rows.push({
        event_id: eventId,
        name: `${g.name} - Guest ${j}`,
        is_primary: false,
        primary_guest_name: g.name,
        tags: [],
        notes: null,
        is_vip: false,
        is_checked_in: false,
        is_duplicate_flag: false,
      });
    }
  }

  const { error } = await supabase.from("guests").insert(rows);
  if (error) throw error;
}

// ============================================================
// FUZZY DUPLICATE CHECK
// ============================================================
async function checkDuplicate(eventId, name) {
  const { data: existing } = await supabase
    .from("guests")
    .select("name")
    .eq("event_id", eventId)
    .eq("is_primary", true);

  if (!existing) return false;

  const normalize = (s) => s.toLowerCase().replace(/[^a-z]/g, "");
  const normalized = normalize(name);

  for (const row of existing) {
    const n = normalize(row.name);
    if (n === normalized) return true;
    // Simple similarity check
    if (
      n.includes(normalized) ||
      normalized.includes(n) ||
      levenshtein(n, normalized) <= 2
    ) {
      return true;
    }
  }
  return false;
}

function levenshtein(a, b) {
  const m = a.length,
    n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0)
      );
  return dp[m][n];
}

// ============================================================
// FUZZY BEST MATCH (for removal matching)
// ============================================================
function findBestMatch(name, existingGuests) {
  const normalize = (s) => s.toLowerCase().replace(/[^a-z]/g, "");
  const normalized = normalize(name);

  // Exact normalized match
  for (const g of existingGuests) {
    if (normalize(g.name) === normalized) return g;
  }

  // Substring or close Levenshtein match
  let bestMatch = null;
  let bestScore = Infinity;
  for (const g of existingGuests) {
    const n = normalize(g.name);
    if (n.includes(normalized) || normalized.includes(n)) return g;
    const dist = levenshtein(n, normalized);
    if (dist <= 2 && dist < bestScore) {
      bestScore = dist;
      bestMatch = g;
    }
  }
  return bestMatch;
}

// ============================================================
// BACKGROUND REMOVAL PROCESSING (Twilio "remove" command)
// ============================================================
async function processRemovalInBackground(fromNumber, body) {
  const { data: events } = await supabase
    .from("events")
    .select("*")
    .eq("is_active", true)
    .order("created_at", { ascending: false });

  if (!events || events.length === 0) {
    await sendReply(fromNumber, "No active events found.");
    return;
  }

  const namesText = body.replace(/^remove\s*/i, "").trim();
  if (!namesText) {
    await sendReply(
      fromNumber,
      "Please specify names to remove. Example:\nremove\nJohn Smith\nJane Doe"
    );
    return;
  }

  const parseResult = await parseNamesWithClaude(namesText, events);

  if (parseResult.needs_clarification) {
    await supabase.from("pending_submissions").insert({
      phone_number: fromNumber,
      raw_text: body,
      parsed_data: JSON.stringify({ awaiting_event: true, action: "remove" }),
      status: "awaiting_event",
    });
    await sendReply(fromNumber, parseResult.clarification_message);
    return;
  }

  // Find matching guests
  const { data: existingGuests } = await supabase
    .from("guests")
    .select("*")
    .eq("event_id", parseResult.event_id)
    .eq("is_primary", true);

  const matches = [];
  const noMatch = [];

  for (const parsedGuest of parseResult.guests) {
    const match = findBestMatch(parsedGuest.name, existingGuests || []);
    if (match) {
      matches.push(match);
      // Also find their plus-ones
      const { data: plusOnes } = await supabase
        .from("guests")
        .select("*")
        .eq("event_id", parseResult.event_id)
        .eq("primary_guest_name", match.name)
        .eq("is_primary", false);
      if (plusOnes?.length > 0) {
        matches.push(...plusOnes);
      }
    } else {
      noMatch.push(parsedGuest.name);
    }
  }

  if (matches.length === 0) {
    await sendReply(
      fromNumber,
      `No matching guests found in "${parseResult.event_name}". No one was removed.`
    );
    return;
  }

  const primaryMatches = matches.filter((m) => m.is_primary);
  let msg = `Removing from "${parseResult.event_name}":\n`;
  primaryMatches.forEach((m, i) => {
    const plusOnes = matches.filter(
      (p) => !p.is_primary && p.primary_guest_name === m.name
    );
    let line = `${i + 1}. ${m.name}`;
    if (plusOnes.length > 0) line += ` (+${plusOnes.length})`;
    msg += line + "\n";
  });
  if (noMatch.length > 0) {
    msg += `\nNo match found for: ${noMatch.join(", ")}`;
  }
  msg += `\nTotal: ${matches.length} guests will be removed`;
  msg += "\n\nReply YES to confirm or NO to cancel.";

  await supabase.from("pending_submissions").insert({
    phone_number: fromNumber,
    raw_text: body,
    parsed_data: JSON.stringify({
      action: "remove",
      event_id: parseResult.event_id,
      event_name: parseResult.event_name,
      guest_ids: matches.map((m) => m.id),
    }),
    status: "pending",
  });

  await sendReply(fromNumber, msg);
}

// ============================================================
// PWA MANIFEST
// ============================================================
app.get("/manifest.json", (req, res) => {
  res.json({
    name: "GuestList",
    short_name: "GuestList",
    start_url: "/",
    display: "standalone",
    background_color: "#0a0a0b",
    theme_color: "#0a0a0b",
    icons: [
      {
        src: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect fill='%230a0a0b' width='100' height='100' rx='20'/><text y='70' x='50' text-anchor='middle' font-size='60'>🎫</text></svg>",
        sizes: "any",
        type: "image/svg+xml",
      },
    ],
  });
});

// ============================================================
// ROOT ROUTE
// ============================================================
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "GuestList API" });
});

// ============================================================
// REST API ROUTES
// ============================================================

// --- Events ---
app.get("/api/events", async (req, res) => {
  const { data, error } = await supabase
    .from("events")
    .select("id, name, date, is_active, created_at")
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post("/api/events", async (req, res) => {
  const { name, pin, admin_pin, date } = req.body;
  if (!admin_pin) return res.status(400).json({ error: "admin_pin is required" });
  const { data, error } = await supabase
    .from("events")
    .insert({ name, pin, admin_pin, date, is_active: true })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch("/api/events/:id", async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase
    .from("events")
    .update(req.body)
    .eq("id", id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete("/api/events/:id", async (req, res) => {
  const { id } = req.params;
  // Delete all guests for this event first
  await supabase.from("guests").delete().eq("event_id", id);
  const { error } = await supabase.from("events").delete().eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// --- Guests ---
app.get("/api/events/:eventId/guests", async (req, res) => {
  const { eventId } = req.params;
  const { data, error } = await supabase
    .from("guests")
    .select("*")
    .eq("event_id", eventId)
    .order("name", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post("/api/events/:eventId/guests", async (req, res) => {
  const { eventId } = req.params;
  const { name, is_vip, tags, notes, plus_count } = req.body;
  const rows = [
    {
      event_id: eventId,
      name,
      is_primary: true,
      is_vip: is_vip || false,
      tags: tags || [],
      notes: notes || null,
      is_checked_in: false,
      is_duplicate_flag: false,
    },
  ];
  for (let j = 1; j <= (plus_count || 0); j++) {
    rows.push({
      event_id: eventId,
      name: `${name} - Guest ${j}`,
      is_primary: false,
      primary_guest_name: name,
      tags: [],
      notes: null,
      is_vip: false,
      is_checked_in: false,
      is_duplicate_flag: false,
    });
  }
  const { data, error } = await supabase.from("guests").insert(rows).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// --- Bulk add guests ---
app.post("/api/events/:eventId/guests/bulk", async (req, res) => {
  const { eventId } = req.params;
  const { guests } = req.body;
  if (!Array.isArray(guests) || guests.length === 0) {
    return res.status(400).json({ error: "guests array is required" });
  }
  const rows = [];
  for (const g of guests) {
    const isDuplicate = await checkDuplicate(eventId, g.name);
    rows.push({
      event_id: eventId,
      name: g.name,
      is_primary: true,
      is_vip: g.is_vip || false,
      tags: g.tags || [],
      notes: g.notes || null,
      is_checked_in: false,
      is_duplicate_flag: isDuplicate,
    });
    for (let j = 1; j <= (g.plus_count || 0); j++) {
      rows.push({
        event_id: eventId,
        name: `${g.name} - Guest ${j}`,
        is_primary: false,
        primary_guest_name: g.name,
        tags: [],
        notes: null,
        is_vip: false,
        is_checked_in: false,
        is_duplicate_flag: false,
      });
    }
  }
  const { data, error } = await supabase.from("guests").insert(rows).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// --- Admin: Edit guest ---
app.patch("/api/events/:eventId/guests/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const allowed = ["name", "is_vip", "tags", "notes", "plus_count"];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "No valid fields to update" });
  }
  const { data, error } = await supabase
    .from("guests")
    .update(updates)
    .eq("id", id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// --- Admin: Manage plus-ones ---
app.put("/api/events/:eventId/guests/:id/plus-ones", requireAdmin, async (req, res) => {
  const { eventId, id } = req.params;
  const { count } = req.body;
  const targetCount = Math.max(0, parseInt(count) || 0);

  const { data: primary } = await supabase
    .from("guests")
    .select("name")
    .eq("id", id)
    .single();
  if (!primary) return res.status(404).json({ error: "Guest not found" });

  const { data: existing } = await supabase
    .from("guests")
    .select("*")
    .eq("event_id", eventId)
    .eq("primary_guest_name", primary.name)
    .eq("is_primary", false)
    .order("name");

  const currentCount = existing?.length || 0;

  if (targetCount > currentCount) {
    const newRows = [];
    for (let j = currentCount + 1; j <= targetCount; j++) {
      newRows.push({
        event_id: eventId,
        name: `${primary.name} - Guest ${j}`,
        is_primary: false,
        primary_guest_name: primary.name,
        tags: [],
        notes: null,
        is_vip: false,
        is_checked_in: false,
        is_duplicate_flag: false,
      });
    }
    await supabase.from("guests").insert(newRows);
  } else if (targetCount < currentCount) {
    const toDelete = existing.slice(targetCount);
    const ids = toDelete.map((g) => g.id);
    await supabase.from("guests").delete().in("id", ids);
  }

  res.json({ success: true, count: targetCount });
});

// --- Admin: Delete guest ---
app.delete("/api/events/:eventId/guests/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from("guests").delete().eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// --- Legacy delete (no admin check, kept for backward compat) ---
app.delete("/api/guests/:id", async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from("guests").delete().eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// --- Admin: Export guests as CSV ---
app.get("/api/events/:eventId/guests/export", requireAdmin, async (req, res) => {
  const { eventId } = req.params;
  const { data: event } = await supabase
    .from("events")
    .select("name")
    .eq("id", eventId)
    .single();
  const { data: guests, error } = await supabase
    .from("guests")
    .select("*")
    .eq("event_id", eventId)
    .order("name", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });

  const escCSV = (val) => {
    if (val == null) return "";
    const s = String(val);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };

  const header = "Name,VIP,Tags,Notes,Checked In,Checked In At,Primary,Primary Guest";
  const rows = (guests || []).map((g) =>
    [
      escCSV(g.name),
      g.is_vip ? "Yes" : "No",
      escCSV((g.tags || []).join("; ")),
      escCSV(g.notes),
      g.is_checked_in ? "Yes" : "No",
      escCSV(g.checked_in_at || ""),
      g.is_primary ? "Yes" : "No",
      escCSV(g.primary_guest_name || ""),
    ].join(",")
  );

  const csv = [header, ...rows].join("\n");
  const filename = `${(event?.name || "guests").replace(/[^a-zA-Z0-9]/g, "_")}_guest_list.csv`;
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(csv);
});

// --- Check-in ---
app.post("/api/guests/:id/checkin", async (req, res) => {
  const { id } = req.params;

  // Get the guest first
  const { data: guest, error: fetchErr } = await supabase
    .from("guests")
    .select("*, events(name)")
    .eq("id", id)
    .single();

  if (fetchErr) return res.status(500).json({ error: fetchErr.message });

  const { data, error } = await supabase
    .from("guests")
    .update({
      is_checked_in: true,
      checked_in_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // VIP notification (sends via WhatsApp if configured, otherwise SMS)
  if (guest.is_vip && process.env.VIP_NOTIFY_NUMBER) {
    try {
      const useWhatsApp = process.env.USE_WHATSAPP === "true";
      await twilioClient.messages.create({
        body: `🌟 VIP CHECK-IN: ${guest.name} just arrived at "${guest.events.name}"`,
        from: useWhatsApp
          ? `whatsapp:${process.env.TWILIO_PHONE_NUMBER}`
          : process.env.TWILIO_PHONE_NUMBER,
        to: useWhatsApp
          ? `whatsapp:${process.env.VIP_NOTIFY_NUMBER}`
          : process.env.VIP_NOTIFY_NUMBER,
      });
    } catch (smsErr) {
      console.error("VIP notification failed:", smsErr);
    }
  }

  res.json(data);
});

app.post("/api/guests/:id/undo-checkin", async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase
    .from("guests")
    .update({ is_checked_in: false, checked_in_at: null })
    .eq("id", id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// --- PIN verification (returns role: "admin" or "user") ---
app.post("/api/events/:eventId/verify-pin", async (req, res) => {
  const { eventId } = req.params;
  const { pin } = req.body;
  const { data: event } = await supabase
    .from("events")
    .select("id, name, pin, admin_pin")
    .eq("id", eventId)
    .single();

  if (!event) return res.status(404).json({ error: "Event not found" });

  if (event.admin_pin && pin === event.admin_pin) {
    return res.json({ success: true, event_name: event.name, role: "admin" });
  }
  if (pin === event.pin) {
    return res.json({ success: true, event_name: event.name, role: "user" });
  }
  res.status(401).json({ error: "Invalid PIN" });
});

// --- Admin PIN verification middleware ---
async function requireAdmin(req, res, next) {
  const adminPin = req.headers["x-admin-pin"];
  const adminEmail = req.headers["x-admin-email"];
  const eventId = req.params.eventId;

  // OAuth admin: verify email is in global_admins
  if (adminEmail) {
    const { data: admin } = await supabase
      .from("global_admins")
      .select("id")
      .eq("email", adminEmail.toLowerCase())
      .single();
    if (admin) return next();
    return res.status(403).json({ error: "Not an authorized admin" });
  }

  // PIN-based admin
  if (!adminPin || !eventId) {
    return res.status(401).json({ error: "Admin PIN required" });
  }
  const { data: event } = await supabase
    .from("events")
    .select("admin_pin")
    .eq("id", eventId)
    .single();
  if (!event) return res.status(404).json({ error: "Event not found" });
  if (event.admin_pin !== adminPin) {
    return res.status(403).json({ error: "Invalid admin PIN" });
  }
  next();
}

// --- Google OAuth verification ---
app.post("/api/auth/verify-google", async (req, res) => {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: "credential is required" });

  try {
    // Verify token with Google
    const verifyRes = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`
    );
    if (!verifyRes.ok) return res.status(401).json({ error: "Invalid token" });
    const payload = await verifyRes.json();

    if (!payload.email || payload.email_verified !== "true") {
      return res.status(401).json({ error: "Email not verified" });
    }

    // Check if user is a global admin
    const { data: admin } = await supabase
      .from("global_admins")
      .select("*")
      .eq("email", payload.email.toLowerCase())
      .single();

    res.json({
      authorized: !!admin,
      email: payload.email.toLowerCase(),
      name: payload.name || "",
      picture: payload.picture || "",
    });
  } catch (err) {
    console.error("Google auth error:", err);
    res.status(500).json({ error: "Authentication failed" });
  }
});

// --- Global Admins ---
app.get("/api/global-admins", async (req, res) => {
  const { data, error } = await supabase
    .from("global_admins")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.post("/api/global-admins", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "email is required" });
  const { data, error } = await supabase
    .from("global_admins")
    .insert({ email: email.toLowerCase() })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete("/api/global-admins/:id", async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from("global_admins").delete().eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// --- Bulk delete guests ---
app.post("/api/events/:eventId/guests/bulk-delete", requireAdmin, async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: "ids array is required" });
  }
  const { error } = await supabase.from("guests").delete().in("id", ids);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, deleted: ids.length });
});

// --- Authorized Users ---
app.get("/api/authorized-users", async (req, res) => {
  const { data, error } = await supabase
    .from("authorized_users")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post("/api/authorized-users", async (req, res) => {
  const { phone_number, name } = req.body;
  const { data, error } = await supabase
    .from("authorized_users")
    .insert({ phone_number, name })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete("/api/authorized-users/:id", async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase
    .from("authorized_users")
    .delete()
    .eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// --- Stats ---
app.get("/api/events/:eventId/stats", async (req, res) => {
  const { eventId } = req.params;
  const { data: guests } = await supabase
    .from("guests")
    .select("*")
    .eq("event_id", eventId);

  if (!guests) return res.json({ total: 0, checked_in: 0, vips: 0 });

  res.json({
    total: guests.length,
    checked_in: guests.filter((g) => g.is_checked_in).length,
    vips: guests.filter((g) => g.is_vip).length,
    vips_checked_in: guests.filter((g) => g.is_vip && g.is_checked_in).length,
    duplicates: guests.filter((g) => g.is_duplicate_flag).length,
  });
});

// ============================================================
// START SERVER
// ============================================================
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🎫 GuestList server running on port ${PORT}`);
});
