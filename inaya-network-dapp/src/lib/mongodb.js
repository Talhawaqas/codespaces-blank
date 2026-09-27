import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI; 
const options = {};

let client;
let clientPromise;

if (!process.env.MONGODB_URI) {
  throw new Error('Please add your MONGODB_URI to .env.local file');
}

if (process.env.NODE_ENV === 'development') {
  if (!global._mongoClientPromise) {
    client = new MongoClient(uri, options);
    global._mongoClientPromise = client.connect();
  }
  clientPromise = global._mongoClientPromise;
} else {
  client = new MongoClient(uri, options);
  clientPromise = client.connect();
}

// Exposed so the test runner can close the connection when a test file finishes (test/_close-mongo.mjs); otherwise an open connection keeps the
// process alive after its tests pass and the whole run hangs. Harmless in production.
globalThis.__inayaMongoClientPromise = clientPromise;

export async function connectToDatabase() {
  const client = await clientPromise;
  const db = client.db("inaya_network_corporate");
  return { client, db };
}

// Bhasudi khatam karne wali aakhri line
export default clientPromise;
