/*
 * Firebase konfigurace pro spolupráci (projekt nettracer-f274b).
 * Klíč apiKey není tajný – u webových Firebase aplikací je veřejný; přístup hlídají
 * pravidla databáze (firestore.rules) a přihlášení.
 * databaseURL není nutné – Frame-Tracer použije Firestore (Realtime Database jen když přidáš databaseURL).
 */
window.NETTRACER_FIREBASE = {
  apiKey: "AIzaSyDzHYdZx37oLSomOfOEwQAybfIOitmbh4c",
  authDomain: "nettracer-f274b.firebaseapp.com",
  projectId: "nettracer-f274b",
  storageBucket: "nettracer-f274b.firebasestorage.app",
  messagingSenderId: "24357996506",
  appId: "1:24357996506:web:ea3a539aecf99c490be2e3",
  measurementId: "G-23TBWWEF86"
};
