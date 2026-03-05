import express from "express";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import { initializeApp } from "firebase/app";
import { getDatabase, ref, get, runTransaction } from "firebase/database";
import session from "express-session";
import Stripe from "stripe";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const stripeEndpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

if (!stripeEndpointSecret) {
  console.warn(
    "Warning: STRIPE_WEBHOOK_SECRET not set. Webhook signature verification will fail.",
  );
}

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyDdTF6elencgMx_bid3e_GNwgjdRGRaKoM",
  authDomain: "pm-seats.firebaseapp.com",
  databaseURL: "https://pm-seats-default-rtdb.firebaseio.com/",
  projectId: "pm-seats",
  storageBucket: "pm-seats.firebasestorage.app",
  messagingSenderId: "64143629785",
  appId: "1:64143629785:web:77678bd02c91dd9a110dc8",
};

// Initialize Firebase
const firebaseApp = initializeApp(firebaseConfig);
const db = getDatabase(firebaseApp);

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
app.use(
  session({
    secret: "pm-seats-secret-2025",
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 },
  }),
);

// Get seat data from Firebase
const getSeatsData = async () => {
  try {
    const seatsRef = ref(db, "seats");
    const snapshot = await get(seatsRef);
    const data = snapshot.val();
    return {
      available: data?.available || 0,
      total: data?.total || 0,
    };
  } catch (error) {
    console.error("Error fetching seats:", error);
    return {
      available: 0,
      total: 0,
    };
  }
};

app.get("/", async (req, res) => {
  const seats = await getSeatsData();
  res.render("index", { seats });
});

// Health check endpoint to verify deployment and config
app.get("/api/health", async (req, res) => {
  try {
    const seats = await getSeatsData();
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      seats: seats,
      config: {
        hasStripeKey: !!process.env.STRIPE_SECRET_KEY,
        hasWebhookSecret: !!process.env.STRIPE_WEBHOOK_SECRET,
        nodeVersion: process.version,
      },
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      error: error.message,
    });
  }
});

// Webhook endpoint to handle Stripe payment confirmation
app.post(
  "/api/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    if (!stripeEndpointSecret) {
      return res.status(500).json({ error: "Missing STRIPE_WEBHOOK_SECRET" });
    }

    const sig = req.headers["stripe-signature"];
    console.log("Webhook received");
    console.log("Signature:", sig ? "present" : "missing");

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        stripeEndpointSecret,
      );
      console.log("Webhook signature verified successfully");
    } catch (err) {
      console.error("Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log("Event type:", event.type);

    // Prevent duplicate processing because Stripe retries webhook delivery.
    const eventRef = ref(db, `processedStripeEvents/${event.id}`);
    const eventTx = await runTransaction(
      eventRef,
      (current) => {
        if (current !== null) {
          return;
        }

        return {
          processedAt: Date.now(),
          type: event.type,
        };
      },
      { applyLocally: false },
    );

    if (!eventTx.committed) {
      console.log("Duplicate event ignored:", event.id);
      return res.status(200).json({ received: true, duplicate: true });
    }

    // Handle checkout.session.completed event
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      console.log("Payment successful for session:", session.id);

      // Decrement seats atomically using Firebase transaction
      try {
        const result = await decrementSeats();
        console.log("Seats decremented successfully:", result);
        return res.status(200).json({ received: true, success: true });
      } catch (error) {
        console.error("Error decrementing seats:", error);
        return res
          .status(500)
          .json({ error: "Failed to process seat decrement" });
      }
    } else {
      console.log("Ignoring event type:", event.type);
    }

    res.json({ received: true });
  },
);

// Server-side function to decrement seats atomically
const decrementSeats = async () => {
  try {
    console.log("decrementSeats: Starting seat decrement transaction...");

    // First, check what's actually in Firebase
    const seatsRef = ref(db, "seats");
    const fullSnapshot = await get(seatsRef);
    console.log(
      "decrementSeats: Full seats object from Firebase:",
      JSON.stringify(fullSnapshot.val()),
    );

    const availableRef = ref(db, "seats/available");
    const availableSnapshot = await get(availableRef);
    console.log(
      "decrementSeats: Direct available value:",
      availableSnapshot.val(),
      "type:",
      typeof availableSnapshot.val(),
    );

    const tx = await runTransaction(
      availableRef,
      (current) => {
        console.log(
          "decrementSeats: Transaction function called with current value:",
          current,
          "type:",
          typeof current,
        );

        // On first call, current is null - return a sentinel to let transaction continue
        if (current === null) {
          console.log(
            "decrementSeats: First transaction call (null) - continuing...",
          );
          return current; // Return current to signal "read the value and call me again"
        }

        const available = Number(current);
        if (!Number.isFinite(available) || available <= 0) {
          console.log(
            "decrementSeats: Aborting - no seats available. Available value:",
            available,
          );
          return; // Abort transaction
        }

        console.log(
          `decrementSeats: Decrementing from ${available} to ${available - 1}`,
        );
        return available - 1;
      },
      { applyLocally: false },
    );

    console.log(
      "decrementSeats: Transaction result - committed:",
      tx.committed,
      "snapshot:",
      tx.snapshot.val(),
    );

    if (tx.committed) {
      console.log("Seats decremented. Available:", tx.snapshot.val());
      return true;
    }

    console.error("No seats available to decrement");
    return false;
  } catch (error) {
    console.error("Error in decrementSeats:", error);
    throw error;
  }
};

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
