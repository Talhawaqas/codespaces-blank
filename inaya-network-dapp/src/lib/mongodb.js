import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI; 
// Serverless: every function instance keeps its own pool, and the cluster
// allows 500 connections in total. With the driver's default (up to 100 per
// instance, idle ones kept open) a burst of parallel requests -- one Business
// Workspace screen fires several -- spun up enough instances to exhaust the
// limit, and Atlas then refused new connections ("tlsv1 alert internal
// error", pool cleared), failing every API at once (2026-10-24). A small
// pool per instance, with idle connections closed, keeps the total well
// under the limit; requests within one instance queue briefly instead.
const options = {
  maxPoolSize: 10,
  minPoolSize: 0,
  maxIdleTimeMS: 30000,
  serverSelectionTimeoutMS: 10000,
};

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

export async function connectToDatabase() {
  const client = await clientPromise;
  const db = client.db("inaya_network_corporate");
  return { client, db };
}

// Bhasudi khatam karne wali aakhri line
export default clientPromise;
