// Import required libraries
import express from "express";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import { initializeApp } from "firebase/app";
import { getDatabase, ref, get, set, runTransaction } from "firebase/database";
import Stripe from "stripe"; // Stripe payment library
import dotenv from "dotenv";
import nodemailer from "nodemailer";

// Load environment variables from .env file
dotenv.config();

// Create Express app and set port (use PORT from .env or default to 3000)
const app = express();
const port = process.env.PORT || 3000;

// Get the directory path (needed for ES modules to work like CommonJS __dirname)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Set up Stripe payment processor with secret key from environment variables
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const stripeEndpointSecret = process.env.STRIPE_WEBHOOK_SECRET; // Secret to verify Stripe webhook requests

const emailTransporter =
  process.env.EMAIL_USER && process.env.EMAIL_PASS
    ? nodemailer.createTransport({
        host: process.env.EMAIL_HOST || "smtp.gmail.com",
        port: Number(process.env.EMAIL_PORT || 465),
        secure: process.env.EMAIL_SECURE !== "false",
        auth: {
          user: process.env.EMAIL_USER,
          pass: String(process.env.EMAIL_PASS).replace(/\s+/g, ""),
        },
      })
    : null;

// Warn if webhook secret is missing (won't be able to verify Stripe payments)
if (!stripeEndpointSecret) {
  console.warn(
    "Warning: STRIPE_WEBHOOK_SECRET not set. Webhook signature verification will fail.",
  );
}

if (!emailTransporter) {
  console.warn(
    "Warning: EMAIL_USER/EMAIL_PASS not set. Buyer confirmation emails are disabled.",
  );
}

// Firebase project configuration (credentials to connect to Firebase)
const firebaseConfig = {
  apiKey: "AIzaSyDdTF6elencgMx_bid3e_GNwgjdRGRaKoM",
  authDomain: "pm-seats.firebaseapp.com",
  databaseURL: "https://pm-seats-default-rtdb.firebaseio.com/",
  projectId: "pm-seats",
  storageBucket: "pm-seats.firebasestorage.app",
  messagingSenderId: "64143629785",
  appId: "1:64143629785:web:77678bd02c91dd9a110dc8",
};

// Initialize Firebase and get reference to the database
const firebaseApp = initializeApp(firebaseConfig);
const db = getDatabase(firebaseApp);

// Configure Express app to use EJS templating engine
app.set("view engine", "ejs");
// Set folder where EJS template files are stored
app.set("views", path.join(__dirname, "views"));

// Parse URL-encoded form data (like from HTML forms)
app.use(bodyParser.urlencoded({ extended: true }));

// Serve static files (CSS, images, etc.) from the "public" folder
app.use(express.static(path.join(__dirname, "public")));

// Function to fetch seat availability data from Firebase database
const getSeatsData = async () => {
  try {
    // Get reference to "seats" collection in Firebase
    const seatsRef = ref(db, "seats");
    // Fetch the data from Firebase
    const snapshot = await get(seatsRef);
    const data = snapshot.val();
    // Return available and total seats (default to 0 if not found)
    return {
      available: data?.available || 0,
      total: data?.total || 0,
    };
  } catch (error) {
    // If error occurs, log it and return zeros
    console.error("Error fetching seats:", error);
    return {
      available: 0,
      total: 0,
    };
  }
};

const extractSeatNumber = (seatId) => {
  const match = String(seatId).match(/(\d+)/);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
};

const getSortedSeatIds = async () => {
  const seatIdRef = ref(db, "seatID");
  const snapshot = await get(seatIdRef);
  const seatData = snapshot.val();

  if (!seatData || typeof seatData !== "object") {
    return [];
  }

  const collected = new Set();
  for (const [key, value] of Object.entries(seatData)) {
    if (typeof key === "string" && key.trim().length > 0) {
      collected.add(key);
      continue;
    }

    if (value && typeof value.seatId === "string") {
      collected.add(value.seatId);
    }
  }

  return [...collected].sort((a, b) => {
    const numberA = extractSeatNumber(a);
    const numberB = extractSeatNumber(b);

    if (numberA !== numberB) {
      return numberA - numberB;
    }

    return a.localeCompare(b);
  });
};

const assignNextSeatId = async (availableAfterPurchase) => {
  const seatIds = await getSortedSeatIds();

  if (!seatIds.length) {
    throw new Error("No seat IDs found in seatID node.");
  }

  const available = Number(availableAfterPurchase);
  if (!Number.isFinite(available) || available < 0) {
    throw new Error("Invalid available seat count after purchase.");
  }

  const soldCount = seatIds.length - available;
  const assignedIndex = soldCount - 1;

  if (assignedIndex < 0 || assignedIndex >= seatIds.length) {
    throw new Error("No remaining seat IDs to assign.");
  }

  const seatId = seatIds[assignedIndex];

  if (!seatId) {
    throw new Error("Failed to resolve assigned seat ID.");
  }

  return {
    seatId,
    seatNumber: extractSeatNumber(seatId),
    seatIndex: assignedIndex,
  };
};

const markSeatReserved = async (seatId) => {
  const statusRef = ref(db, `seatID/${seatId}/status`);
  await set(statusRef, "reserved");
};

const saveRegistration = async ({
  sessionId,
  customerName,
  customerEmail,
  seatId,
  seatNumber,
  amountTotal,
  currency,
}) => {
  const registrationRef = ref(db, `registrations/${sessionId}`);
  await set(registrationRef, {
    sessionId,
    customerName,
    customerEmail,
    seatId,
    seatNumber,
    amountTotal: amountTotal ?? null,
    currency: currency ?? null,
    createdAt: Date.now(),
  });
};

const sendSeatConfirmationEmail = async ({
  customerName,
  customerEmail,
  seatId,
}) => {
  if (!emailTransporter) {
    throw new Error("Email transporter not configured.");
  }

  await emailTransporter.sendMail({
    from: process.env.EMAIL_FROM || `PM Launchpad <${process.env.EMAIL_USER}>`,
    to: customerEmail,
    subject: "Payment confirmed - Your PM Launchpad seat",
    html: `
      <p>Hi ${customerName || "there"},</p>
      <p>Thank you for your payment. Your seat is confirmed.</p>
      <p><strong>Your Seat ID: ${seatId}</strong></p>
      <p>We will share the remaining event details with you shortly.</p>
      <p>PM Launchpad Team</p>
    `,
  });
};

// Route: When user visits the home page (/)
app.get("/", async (req, res) => {
  // Get current seat data from Firebase
  const seats = await getSeatsData();
  // Display the index.ejs template and pass seats data to it
  res.render("index", { seats });
});

// Route: Health check endpoint - used to verify server and config are working
app.get("/api/health", async (req, res) => {
  try {
    // Get current seat data
    const seats = await getSeatsData();
    // Return JSON response with status, timestamp, seats, and configuration info
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      seats: seats,
      config: {
        hasStripeKey: !!process.env.STRIPE_SECRET_KEY, // Check if Stripe key is set
        hasWebhookSecret: !!process.env.STRIPE_WEBHOOK_SECRET, // Check if webhook secret is set
        nodeVersion: process.version, // Show Node.js version
      },
    });
  } catch (error) {
    // If error occurs, return error status
    res.status(500).json({
      status: "error",
      error: error.message,
    });
  }
});

// Route: Webhook endpoint - receives payment confirmation from Stripe
app.post(
  "/api/webhook",
  express.raw({ type: "application/json" }), // Accept raw JSON for Stripe signature verification
  async (req, res) => {
    // Check if webhook secret is configured
    if (!stripeEndpointSecret) {
      return res.status(500).json({ error: "Missing STRIPE_WEBHOOK_SECRET" });
    }

    // Get Stripe signature from request headers
    const sig = req.headers["stripe-signature"];

    // Verify and parse the Stripe event
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        stripeEndpointSecret,
      );
    } catch (err) {
      // If signature verification fails, reject the request
      console.error("Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log(`Webhook received: ${event.type}`);

    // Check if this event has already been processed (Stripe may send duplicate webhooks)
    const eventRef = ref(db, `processedStripeEvents/${event.id}`);
    const eventTx = await runTransaction(
      eventRef,
      (current) => {
        // If event has already completed, skip processing.
        if (current?.status === "completed") {
          return;
        }

        // Allow retries for previously failed events.
        if (current?.status === "failed") {
          return {
            ...current,
            status: "processing",
            updatedAt: Date.now(),
          };
        }

        // If another instance is processing this event, skip duplicate handling.
        if (current?.status === "processing") {
          return;
        }

        // Mark this event as in progress.
        return {
          status: "processing",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          type: event.type,
        };
      },
      { applyLocally: false },
    );

    // If event was already processed, return early
    if (!eventTx.committed) {
      console.log("Duplicate event ignored:", event.id);
      return res.status(200).json({ received: true, duplicate: true });
    }

    // Handle payment completion event
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      console.log("Payment completed for session:", session.id);

      const customerName = session.customer_details?.name || "there";
      const customerEmail =
        session.customer_details?.email || session.customer_email;

      if (!customerEmail) {
        await set(eventRef, {
          status: "failed",
          type: event.type,
          failedAt: Date.now(),
          reason: "Missing customer email in Stripe session",
        });
        return res.status(400).json({ error: "Missing customer email" });
      }

      try {
        const availableAfterPurchase = await decrementSeats();

        if (availableAfterPurchase === null) {
          await set(eventRef, {
            status: "failed",
            type: event.type,
            failedAt: Date.now(),
            reason: "No seats available to decrement",
          });
          return res.status(409).json({ error: "No seats available" });
        }

        const assigned = await assignNextSeatId(availableAfterPurchase);

        await markSeatReserved(assigned.seatId);

        await saveRegistration({
          sessionId: session.id,
          customerName,
          customerEmail,
          seatId: assigned.seatId,
          seatNumber: assigned.seatNumber,
          amountTotal: session.amount_total,
          currency: session.currency,
        });

        let emailSent = false;
        let emailError = null;

        try {
          await sendSeatConfirmationEmail({
            customerName,
            customerEmail,
            seatId: assigned.seatId,
          });
          emailSent = true;
        } catch (emailSendError) {
          emailError = emailSendError.message;
          console.error(
            "Failed to send buyer confirmation email:",
            emailSendError,
          );
        }

        await set(eventRef, {
          status: "completed",
          type: event.type,
          processedAt: Date.now(),
          sessionId: session.id,
          seatId: assigned.seatId,
          customerEmail,
          emailSent,
          emailError,
        });

        return res.status(200).json({
          received: true,
          success: true,
          seatId: assigned.seatId,
          emailSent,
        });
      } catch (error) {
        console.error("Error processing completed checkout session:", error);
        await set(eventRef, {
          status: "failed",
          type: event.type,
          failedAt: Date.now(),
          reason: error.message,
        });
        return res
          .status(500)
          .json({ error: "Failed to process payment event" });
      }
    } else {
      // Ignore other event types we don't care about
      console.log("Ignoring event type:", event.type);
    }

    res.json({ received: true });
  },
);

// Function to safely reduce available seats by 1 (uses Firebase transaction to prevent race conditions)
const decrementSeats = async () => {
  try {
    // Get reference to the "available" seats count in Firebase
    const availableRef = ref(db, "seats/available");

    // Use transaction to atomically decrease seats (prevents multiple users from buying same seat)
    const tx = await runTransaction(
      availableRef,
      (current) => {
        // If value doesn't exist yet, return null to continue transaction
        if (current === null) {
          return current;
        }

        // Convert to number and validate it's a valid positive number
        const available = Number(current);
        if (!Number.isFinite(available) || available <= 0) {
          return; // Abort transaction - no seats available to sell
        }

        // Decrease available seats by 1
        return available - 1;
      },
      { applyLocally: false }, // Make sure we check the real database value
    );

    // Check if transaction was successfully committed
    if (tx.committed) {
      console.log(
        "Seats decremented successfully. Available:",
        tx.snapshot.val(),
      );
      return Number(tx.snapshot.val());
    }

    // Transaction failed - no seats available
    console.error("Failed to decrement seats - no seats available");
    return null;
  } catch (error) {
    console.error("Error in decrementSeats:", error);
    throw error;
  }
};

// Start the server and listen for incoming requests
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
