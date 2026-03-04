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
    display: "browser",
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
// TALENT / TEAM GUEST LIST ALLOCATIONS
// ============================================================

const crypto = require("crypto");

function slugify(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function generateInviteToken(name) {
  const slug = slugify(name) || "guest";
  const rand = crypto.randomBytes(8).toString("hex");
  return `${slug}-${rand}`;
}

// --- Create talent allocation for an event ---
app.post("/api/events/:eventId/talent", requireAdmin, async (req, res) => {
  const { eventId } = req.params;
  const { name, max_guests, deadline } = req.body;
  if (!name || !max_guests) return res.status(400).json({ error: "name and max_guests are required" });

  const token = generateInviteToken(name);

  const { data, error } = await supabase
    .from("talent_allocations")
    .insert({
      event_id: eventId,
      name: name.trim(),
      max_guests: parseInt(max_guests),
      deadline: deadline || null,
      token,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// --- List talent allocations for an event ---
app.get("/api/events/:eventId/talent", async (req, res) => {
  const { eventId } = req.params;
  const { data, error } = await supabase
    .from("talent_allocations")
    .select("*")
    .eq("event_id", eventId)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// --- Update talent allocation ---
app.patch("/api/events/:eventId/talent/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const allowed = ["name", "max_guests", "deadline"];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  // If name changed, regenerate token so URL reflects the new name
  if (updates.name) {
    updates.token = generateInviteToken(updates.name);
  }

  const { data, error } = await supabase
    .from("talent_allocations")
    .update(updates)
    .eq("id", id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// --- Delete talent allocation (and their submitted guests) ---
app.delete("/api/events/:eventId/talent/:id", requireAdmin, async (req, res) => {
  const { id, eventId } = req.params;
  // Get the allocation to find the talent name for deleting tagged guests
  const { data: alloc } = await supabase
    .from("talent_allocations")
    .select("name")
    .eq("id", id)
    .single();
  if (alloc) {
    const tag = `Guest of ${alloc.name}`;
    // Delete guests tagged with this talent's tag
    const { data: taggedGuests } = await supabase
      .from("guests")
      .select("id, tags")
      .eq("event_id", eventId);
    if (taggedGuests) {
      const idsToDelete = taggedGuests
        .filter((g) => (g.tags || []).includes(tag))
        .map((g) => g.id);
      if (idsToDelete.length > 0) {
        await supabase.from("guests").delete().in("id", idsToDelete);
      }
    }
  }
  const { error } = await supabase.from("talent_allocations").delete().eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// --- Public: Get invite details by token ---
app.get("/api/invite/:token", async (req, res) => {
  const { token } = req.params;
  const { data: alloc, error } = await supabase
    .from("talent_allocations")
    .select("*, events(id, name, date, is_active)")
    .eq("token", token)
    .single();
  if (error || !alloc) return res.status(404).json({ error: "Invite not found" });

  // Get currently submitted guests for this allocation
  const { data: currentGuests } = await supabase
    .from("guests")
    .select("id, name")
    .eq("event_id", alloc.event_id)
    .eq("is_primary", true)
    .contains("tags", [`Guest of ${alloc.name}`]);

  res.json({
    id: alloc.id,
    name: alloc.name,
    max_guests: alloc.max_guests,
    deadline: alloc.deadline || (alloc.events?.date ? alloc.events.date + "T00:00:00" : null),
    event_name: alloc.events?.name || "Event",
    event_date: alloc.events?.date || null,
    event_active: alloc.events?.is_active || false,
    current_guests: (currentGuests || []).map((g) => ({ id: g.id, name: g.name })),
  });
});

// --- Public: Submit/update guest list via invite token ---
app.post("/api/invite/:token/guests", async (req, res) => {
  const { token } = req.params;
  const { guests } = req.body; // Array of { name } objects

  if (!Array.isArray(guests)) return res.status(400).json({ error: "guests array is required" });

  // Look up allocation
  const { data: alloc } = await supabase
    .from("talent_allocations")
    .select("*, events(id, name, date, is_active)")
    .eq("token", token)
    .single();
  if (!alloc) return res.status(404).json({ error: "Invite not found" });

  // Check deadline
  const deadline = alloc.deadline || (alloc.events?.date ? alloc.events.date + "T00:00:00" : null);
  if (deadline && new Date() > new Date(deadline)) {
    return res.status(403).json({ error: "The deadline for submitting your guest list has passed." });
  }

  // Check max guests
  if (guests.length > alloc.max_guests) {
    return res.status(400).json({ error: `You can add up to ${alloc.max_guests} guests.` });
  }

  const tag = `Guest of ${alloc.name}`;
  const eventId = alloc.event_id;

  // Remove all previously submitted guests for this allocation
  const { data: existingGuests } = await supabase
    .from("guests")
    .select("id, tags")
    .eq("event_id", eventId)
    .eq("is_primary", true);

  if (existingGuests) {
    const idsToRemove = existingGuests
      .filter((g) => (g.tags || []).includes(tag))
      .map((g) => g.id);
    if (idsToRemove.length > 0) {
      // Also remove their plus-ones
      for (const gId of idsToRemove) {
        const { data: guest } = await supabase
          .from("guests")
          .select("name")
          .eq("id", gId)
          .single();
        if (guest) {
          await supabase
            .from("guests")
            .delete()
            .eq("event_id", eventId)
            .eq("primary_guest_name", guest.name)
            .eq("is_primary", false);
        }
      }
      await supabase.from("guests").delete().in("id", idsToRemove);
    }
  }

  // Insert new guests
  if (guests.length > 0) {
    const rows = guests
      .filter((g) => g.name && g.name.trim())
      .map((g) => ({
        event_id: eventId,
        name: g.name.trim(),
        is_primary: true,
        primary_guest_name: null,
        tags: [tag],
        notes: null,
        is_vip: false,
        is_checked_in: false,
        is_duplicate_flag: false,
      }));

    if (rows.length > 0) {
      const { error: insertErr } = await supabase.from("guests").insert(rows);
      if (insertErr) return res.status(500).json({ error: insertErr.message });
    }
  }

  res.json({ success: true, count: guests.filter((g) => g.name && g.name.trim()).length });
});

// --- Serve the public invite page ---
app.get("/invite/:token", (req, res) => {
  res.send(INVITE_PAGE_HTML);
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
// INVITE PAGE HTML TEMPLATE
// ============================================================
const INVITE_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <meta name="theme-color" content="#0a0a0b" />
  <title>Guest List Invite</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;500;700&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0a0a0b; --surface: #141416; --surface-2: #1c1c20; --surface-3: #252529;
      --border: #2a2a30; --text: #e8e8ec; --text-dim: #8888a0; --text-faint: #55556a;
      --accent: #c8ff3e; --accent-dim: #a0cc32; --danger: #ff4466; --success: #3eff8b;
      --radius: 12px; --radius-sm: 8px;
      --font: 'DM Sans', -apple-system, sans-serif; --mono: 'Space Mono', monospace;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: var(--font); background: var(--bg); color: var(--text); min-height: 100vh; -webkit-font-smoothing: antialiased; }
    .app { max-width: 520px; margin: 0 auto; padding: 24px 16px; min-height: 100vh; }
    .header { text-align: center; margin-bottom: 32px; }
    .header h1 { font-family: var(--mono); font-size: 18px; color: var(--accent); letter-spacing: -0.5px; margin-bottom: 4px; }
    .header .event-name { font-size: 22px; font-weight: 700; margin-bottom: 8px; }
    .header .event-meta { font-size: 13px; color: var(--text-dim); }
    .header .deadline { display: inline-block; margin-top: 8px; font-size: 12px; font-weight: 700; padding: 4px 12px; border-radius: 16px; }
    .deadline.open { background: rgba(62,255,139,0.1); color: var(--success); }
    .deadline.closed { background: rgba(255,68,102,0.12); color: var(--danger); }
    .counter { text-align: center; margin-bottom: 20px; font-family: var(--mono); font-size: 14px; color: var(--text-dim); }
    .counter .num { color: var(--accent); font-weight: 700; font-size: 18px; }
    .guest-inputs { display: flex; flex-direction: column; gap: 8px; margin-bottom: 20px; }
    .guest-row-input { display: flex; gap: 8px; align-items: center; }
    .guest-row-input .idx { font-family: var(--mono); font-size: 12px; color: var(--text-faint); min-width: 20px; text-align: right; }
    .guest-row-input input {
      flex: 1; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm);
      padding: 12px 14px; font-family: var(--font); font-size: 15px; color: var(--text); outline: none; transition: border-color 0.2s;
    }
    .guest-row-input input:focus { border-color: var(--accent); }
    .guest-row-input input::placeholder { color: var(--text-faint); }
    .guest-row-input .remove-btn {
      background: none; border: 1px solid var(--border); color: var(--text-faint); width: 32px; height: 32px;
      border-radius: 6px; cursor: pointer; font-size: 16px; display: flex; align-items: center; justify-content: center; transition: all 0.15s;
    }
    .guest-row-input .remove-btn:hover { border-color: var(--danger); color: var(--danger); }
    .actions { display: flex; flex-direction: column; gap: 8px; }
    .btn {
      background: var(--accent); color: var(--bg); border: none; border-radius: var(--radius-sm);
      padding: 14px 18px; font-family: var(--font); font-size: 15px; font-weight: 700; cursor: pointer; transition: all 0.15s; text-align: center;
    }
    .btn:hover { opacity: 0.9; }
    .btn:active { transform: scale(0.98); }
    .btn:disabled { opacity: 0.4; cursor: not-allowed; transform: none; }
    .btn-ghost { background: transparent; color: var(--text-dim); border: 1px solid var(--border); }
    .btn-ghost:hover { border-color: var(--text-dim); color: var(--text); }
    .status-msg { text-align: center; padding: 12px; border-radius: var(--radius-sm); font-size: 13px; margin-top: 12px; }
    .status-msg.success { background: rgba(62,255,139,0.1); color: var(--success); }
    .status-msg.error { background: rgba(255,68,102,0.1); color: var(--danger); }
    .loading { text-align: center; padding: 60px 20px; color: var(--text-dim); }
    .closed-msg { text-align: center; padding: 40px 20px; }
    .closed-msg .icon { font-size: 40px; margin-bottom: 12px; }
    .closed-msg p { color: var(--text-dim); font-size: 14px; line-height: 1.6; }
    .saved-label { font-size: 11px; color: var(--text-faint); text-align: center; margin-top: 8px; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script>
    const API_URL = window.location.origin;
    const TOKEN = window.location.pathname.split("/invite/")[1];

    let invite = null;
    let guestNames = [];
    let saving = false;
    let statusMsg = null;
    let statusType = "";
    let loaded = false;

    async function loadInvite() {
      try {
        const res = await fetch(API_URL + "/api/invite/" + TOKEN);
        if (!res.ok) { document.getElementById("root").innerHTML = '<div class="loading">Invite not found.</div>'; return; }
        invite = await res.json();
        if (invite.current_guests && invite.current_guests.length > 0) {
          guestNames = invite.current_guests.map(function(g) { return g.name; });
        } else {
          guestNames = [""];
        }
        loaded = true;
        render();
      } catch(e) {
        document.getElementById("root").innerHTML = '<div class="loading">Failed to load invite.</div>';
      }
    }

    function isDeadlinePassed() {
      if (!invite.deadline) return false;
      return new Date() > new Date(invite.deadline);
    }

    function formatDate(d) {
      if (!d) return "";
      var date = new Date(d);
      return date.toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long", year: "numeric", month: "long", day: "numeric" });
    }

    function formatDeadline(d) {
      if (!d) return "No deadline";
      var date = new Date(d);
      var now = new Date();
      var diff = date - now;
      var days = Math.ceil(diff / (1000 * 60 * 60 * 24));
      var opts = { timeZone: "America/New_York" };
      var formatted = date.toLocaleDateString("en-US", Object.assign({ month: "short", day: "numeric", year: "numeric" }, opts));
      var time = date.toLocaleTimeString("en-US", Object.assign({ hour: "numeric", minute: "2-digit" }, opts));
      if (diff < 0) return "Closed " + formatted;
      if (days <= 1) return "Due today by " + time + " ET";
      if (days <= 3) return "Due " + formatted + " at " + time + " ET";
      return "Due " + formatted;
    }

    function addRow() {
      if (guestNames.length >= invite.max_guests) return;
      guestNames.push("");
      render();
      // Focus the new input
      setTimeout(function() {
        var inputs = document.querySelectorAll(".guest-row-input input");
        if (inputs.length > 0) inputs[inputs.length - 1].focus();
      }, 50);
    }

    function removeRow(i) {
      guestNames.splice(i, 1);
      if (guestNames.length === 0) guestNames.push("");
      render();
    }

    // Clean and format a guest name: trim, title case, remove junk
    function cleanName(raw) {
      var name = raw.trim();
      // Remove leading numbers, bullets, dashes (list formatting)
      name = name.replace(/^[\\d]+[.)\\-:\\s]+/, "");
      name = name.replace(/^[-–—•*·\\s]+/, "");
      // Remove trailing commas, semicolons
      name = name.replace(/[,;]+$/, "");
      // Collapse whitespace
      name = name.replace(/\\s+/g, " ").trim();
      if (!name) return "";
      // Title case if all lower or all upper
      if (name === name.toLowerCase() || name === name.toUpperCase()) {
        name = name.replace(/\\b\\w/g, function(c) { return c.toUpperCase(); });
      }
      return name;
    }

    // Handle paste: detect multi-line paste, split into names, clean, and fill rows
    function handlePaste(e, rowIndex) {
      var pasted = (e.clipboardData || window.clipboardData).getData("text");
      if (!pasted) return;
      // Split on newlines, commas, or semicolons
      var lines = pasted.split(/[\\n\\r,;]+/).map(cleanName).filter(function(n) { return n.length > 0; });
      // If only one name (no multi-line), let normal paste happen
      if (lines.length <= 1) return;
      e.preventDefault();
      // Merge: replace current row + add new rows for the rest
      var before = guestNames.slice(0, rowIndex);
      var after = guestNames.slice(rowIndex + 1).filter(function(n) { return n.trim().length > 0; });
      var merged = before.concat(lines).concat(after);
      // Deduplicate (case-insensitive)
      var seen = {};
      var deduped = [];
      for (var i = 0; i < merged.length; i++) {
        var key = merged[i].toLowerCase();
        if (!seen[key]) {
          seen[key] = true;
          deduped.push(merged[i]);
        }
      }
      if (deduped.length > invite.max_guests) {
        // Take what fits, show error
        guestNames = deduped.slice(0, invite.max_guests);
        statusMsg = "Pasted " + deduped.length + " names but max is " + invite.max_guests + ". Only the first " + invite.max_guests + " were kept.";
        statusType = "error";
      } else {
        guestNames = deduped;
        statusMsg = "Pasted " + lines.length + " names.";
        statusType = "success";
      }
      if (guestNames.length === 0) guestNames = [""];
      render();
    }

    // Clean name on blur (tab/click away)
    function handleBlur(i, el) {
      var cleaned = cleanName(guestNames[i]);
      if (cleaned !== guestNames[i]) {
        guestNames[i] = cleaned;
        el.value = cleaned;
      }
    }

    function updateName(i, val) {
      guestNames[i] = val;
      // Re-render counter only
      var counter = document.getElementById("counter");
      var filled = guestNames.filter(function(n) { return n.trim().length > 0; }).length;
      if (counter) counter.innerHTML = '<span class="num">' + filled + '</span> / ' + invite.max_guests + ' guests';
    }

    async function saveGuests() {
      if (saving) return;
      // Clean all names before saving
      guestNames = guestNames.map(cleanName);
      var names = guestNames.filter(function(n) { return n.length > 0; });
      if (names.length > invite.max_guests) {
        statusMsg = "You can only add up to " + invite.max_guests + " guests.";
        statusType = "error";
        render();
        return;
      }
      saving = true;
      statusMsg = null;
      render();
      try {
        var res = await fetch(API_URL + "/api/invite/" + TOKEN + "/guests", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ guests: names.map(function(n) { return { name: n.trim() }; }) })
        });
        var data = await res.json();
        if (res.ok) {
          statusMsg = names.length === 0 ? "Guest list cleared." : "Saved! " + data.count + " guest" + (data.count === 1 ? "" : "s") + " submitted.";
          statusType = "success";
          // Keep empty row if list was cleared
          if (names.length === 0) guestNames = [""];
        } else {
          statusMsg = data.error || "Something went wrong.";
          statusType = "error";
        }
      } catch(e) {
        statusMsg = "Network error. Please try again.";
        statusType = "error";
      }
      saving = false;
      render();
    }

    function render() {
      if (!loaded) { document.getElementById("root").innerHTML = '<div class="loading">Loading...</div>'; return; }
      var closed = isDeadlinePassed();
      var filled = guestNames.filter(function(n) { return n.trim().length > 0; }).length;
      var html = '<div class="app">';
      html += '<div class="header">';
      html += '<h1>GUEST LIST</h1>';
      html += '<div class="event-name">' + esc(invite.event_name) + '</div>';
      if (invite.event_date) html += '<div class="event-meta">' + formatDate(invite.event_date) + '</div>';
      html += '<div class="event-meta" style="margin-top:4px">Invite for <strong>' + esc(invite.name) + '</strong> &mdash; up to ' + invite.max_guests + ' guest' + (invite.max_guests === 1 ? '' : 's') + '</div>';
      if (invite.deadline) {
        html += '<div class="deadline ' + (closed ? 'closed' : 'open') + '">' + formatDeadline(invite.deadline) + '</div>';
      }
      html += '</div>';

      if (closed) {
        html += '<div class="closed-msg"><div class="icon">&#x1f512;</div><p>The deadline for this guest list has passed.<br>Contact the event organizer if you need to make changes.</p></div>';
        if (filled > 0) {
          html += '<div style="margin-top:24px"><div class="counter">Your submitted guests:</div>';
          for (var i = 0; i < guestNames.length; i++) {
            if (guestNames[i].trim()) {
              html += '<div style="padding:8px 14px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);margin-bottom:4px;font-size:14px">' + esc(guestNames[i]) + '</div>';
            }
          }
          html += '</div>';
        }
      } else {
        html += '<div class="counter" id="counter"><span class="num">' + filled + '</span> / ' + invite.max_guests + ' guests</div>';
        html += '<div class="guest-inputs">';
        for (var i = 0; i < guestNames.length; i++) {
          html += '<div class="guest-row-input">';
          html += '<span class="idx">' + (i + 1) + '.</span>';
          html += '<input type="text" placeholder="Guest name" value="' + esc(guestNames[i]) + '" oninput="updateName(' + i + ', this.value)" onpaste="handlePaste(event, ' + i + ')" onblur="handleBlur(' + i + ', this)" />';
          if (guestNames.length > 1) {
            html += '<button class="remove-btn" onclick="removeRow(' + i + ')" title="Remove">&times;</button>';
          }
          html += '</div>';
        }
        html += '</div>';
        html += '<div class="actions">';
        if (guestNames.length < invite.max_guests) {
          html += '<button class="btn btn-ghost" onclick="addRow()">+ Add another guest</button>';
        }
        html += '<button class="btn" onclick="saveGuests()" ' + (saving ? 'disabled' : '') + '>' + (saving ? 'Saving...' : 'Save Guest List') + '</button>';
        html += '</div>';
        if (statusMsg) {
          html += '<div class="status-msg ' + statusType + '">' + esc(statusMsg) + '</div>';
        }
        html += '<div class="saved-label">You can come back and edit this list until the deadline.</div>';
      }
      html += '</div>';
      document.getElementById("root").innerHTML = html;
    }

    function esc(s) {
      if (!s) return "";
      var d = document.createElement("div");
      d.textContent = s;
      return d.innerHTML;
    }

    loadInvite();
  </script>
</body>
</html>`;

// ============================================================
// START SERVER
// ============================================================
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🎫 GuestList server running on port ${PORT}`);
});
