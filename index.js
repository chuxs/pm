import express from "express";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import { initializeApp } from "firebase/app";
import { getDatabase, ref, get } from "firebase/database";
import session from "express-session";

const app = express();
const port = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
