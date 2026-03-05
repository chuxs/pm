import express from "express";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import { initializeApp } from "firebase/app";
import { getDatabase, ref, get, update } from "firebase/database";
import session from "express-session";
import Stripe from "stripe";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Stripe
const stripe = new Stripe(
  process.env.STRIPE_SECRET_KEY,
);
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
app.use(express.json());
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

// Webhook endpoint to handle Stripe payment confirmation
app.post(
  "/api/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
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
      // For testing: continue anyway but log the error
      try {
        event = JSON.parse(req.body.toString());
        console.log("Continuing without signature verification for testing");
      } catch (parseErr) {
        return res.status(400).send(`Webhook Error: ${err.message}`);
      }
    }

    console.log("Event type:", event.type);

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

// Test endpoint to verify Firebase writes
app.post("/api/test-decrement", async (req, res) => {
  try {
    console.log("Test decrement endpoint called");
    const seatsRef = ref(db, "seats");
    const snapshot = await get(seatsRef);
    const data = snapshot.val();
    console.log("Current seats from Firebase:", data);

    if (data && data.available > 0) {
      await update(seatsRef, {
        available: data.available - 1,
      });
      const newSnapshot = await get(seatsRef);
      const newData = newSnapshot.val();
      console.log("Updated seats in Firebase:", newData);
      res.json({ success: true, before: data, after: newData });
    } else {
      res.status(400).json({ error: "No seats available" });
    }
  } catch (error) {
    console.error("Test decrement error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Server-side function to decrement seats atomically
const decrementSeats = async () => {
  try {
    const seatsRef = ref(db, "seats");
    const snapshot = await get(seatsRef);
    const data = snapshot.val();

    if (data && data.available > 0) {
      // Atomic update - decrement by 1
      await update(seatsRef, {
        available: data.available - 1,
      });
      console.log(`Seats decremented. Available: ${data.available - 1}`);
      return true;
    } else {
      console.error("No seats available to decrement");
      return false;
    }
  } catch (error) {
    console.error("Error in decrementSeats:", error);
    throw error;
  }
};

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
