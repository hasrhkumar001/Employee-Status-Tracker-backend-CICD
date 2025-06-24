import { MongoClient } from 'mongodb';
import { connect } from 'mongoose';

const password = encodeURIComponent(process.env.MONGO_PASSWORD.trim());
const connectionString = `mongodb+srv://maabaap2016:${password}@devcluster.25wzrys.mongodb.net/?retryWrites=true&w=majority&appName=DevCluster`;
const client = new MongoClient(connectionString);
let conn;
try{
    conn = await client.connect();
    console.log('MongoDB connected successfully');
}catch (error) {
    console.error('Error connecting to MongoDB:', error);

}
let db = conn.db('DevCluster');
export default db;