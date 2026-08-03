const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const http = require('http');
const socketIo = require('socket.io');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    methods: ["GET", "POST"]
  }
});

// Import routes
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const communityRoutes = require('./routes/communities');
const discussionRoutes = require('./routes/discussions');
const resourceRoutes = require('./routes/resources');
const notificationRoutes = require('./routes/notifications');
const messageRoutes = require('./routes/messages');
const adminRoutes = require('./routes/admin');

// Security middleware
app.use(helmet());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use(limiter);

// CORS configuration
app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:3000",
  credentials: true
}));

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Static files
app.use('/uploads', express.static('uploads'));

// Database connection with better error handling
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/discussify', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 30000, // Increased timeout
  socketTimeoutMS: 0, // No timeout for socket operations
  maxPoolSize: 10, // Maintain up to 10 socket connections
  heartbeatFrequencyMS: 10000, // Check connection every 10 seconds
  retryWrites: true,
  retryReads: true
})
.then(() => {
  console.log('MongoDB connected successfully');
  console.log('Database:', mongoose.connection.db.databaseName);
})
.catch(err => {
  console.error('MongoDB connection error:', err);
  // Only exit in production to avoid dev server flapping
  if ((process.env.NODE_ENV || 'development') === 'production') {
    process.exit(1);
  }
});

// Handle MongoDB connection events
mongoose.connection.on('connected', () => {
  console.log('Mongoose connected to MongoDB');
});

mongoose.connection.on('error', (err) => {
  console.error('Mongoose connection error:', err);
  // Don't exit on connection errors, let mongoose handle reconnection
});

mongoose.connection.on('disconnected', () => {
  console.log('Mongoose disconnected from MongoDB - attempting to reconnect...');
});

mongoose.connection.on('reconnected', () => {
  console.log('Mongoose reconnected to MongoDB');
});

// Keep connection alive (catch ping errors to avoid unhandled rejections)
setInterval(async () => {
  if (mongoose.connection.readyState === 1) {
    try {
      await mongoose.connection.db.admin().ping();
    } catch (pingErr) {
      console.warn('Mongo ping failed:', pingErr.message);
    }
  }
}, 30000); // Ping every 30 seconds

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Received SIGINT. Graceful shutdown...');
  await mongoose.connection.close();
  process.exit(0);
});

// Make io available to routes
app.set('io', io);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/communities', communityRoutes);
app.use('/api/discussions', discussionRoutes);
app.use('/api/resources', resourceRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/admin', adminRoutes);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Socket.IO for real-time features
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Join user-specific room for private messages and update online status
  socket.on('join-user-room', async (userId) => {
    socket.join(`user_${userId}`);
    socket.userId = userId;
    
    // Update user online status
    try {
      const User = require('./models/User');
      await User.findByIdAndUpdate(userId, { 
        isOnline: true, 
        lastSeen: new Date() 
      });
      
      // Broadcast online status to all users
      socket.broadcast.emit('user-online', { userId, isOnline: true });
    } catch (error) {
      console.error('Error updating online status:', error);
    }
    
    console.log(`User ${socket.id} joined user room ${userId}`);
  });

  // Join community rooms for real-time updates
  socket.on('join-community', (communityId) => {
    socket.join(`community-${communityId}`);
    console.log(`User ${socket.id} joined community ${communityId}`);
  });

  // Leave community rooms
  socket.on('leave-community', (communityId) => {
    socket.leave(`community-${communityId}`);
    console.log(`User ${socket.id} left community ${communityId}`);
  });

  // Join conversation room for real-time messaging
  socket.on('join-conversation', (conversationId) => {
    socket.join(`conversation_${conversationId}`);
    console.log(`User ${socket.id} joined conversation ${conversationId}`);
  });

  // Leave conversation room
  socket.on('leave-conversation', (conversationId) => {
    socket.leave(`conversation_${conversationId}`);
    console.log(`User ${socket.id} left conversation ${conversationId}`);
  });

  // Handle typing indicators
  socket.on('typing', (data) => {
    socket.to(`conversation_${data.conversationId}`).emit('user-typing', {
      userId: data.userId,
      isTyping: data.isTyping
    });
  });

  // Handle message read receipts
  socket.on('message-read', (data) => {
    socket.to(`conversation_${data.conversationId}`).emit('message-read', {
      messageId: data.messageId,
      readBy: data.userId
    });
  });

  // Handle new discussion posts
  socket.on('new-discussion', (data) => {
    socket.to(`community-${data.communityId}`).emit('discussion-update', data);
  });

  // Handle new resource shares
  socket.on('new-resource', (data) => {
    socket.to(`community-${data.communityId}`).emit('resource-update', data);
  });

  socket.on('disconnect', async () => {
    console.log('User disconnected:', socket.id);
    
    // Update user offline status
    if (socket.userId) {
      try {
        const User = require('./models/User');
        await User.findByIdAndUpdate(socket.userId, { 
          isOnline: false, 
          lastSeen: new Date() 
        });
        
        // Broadcast offline status to all users
        socket.broadcast.emit('user-online', { 
          userId: socket.userId, 
          isOnline: false,
          lastSeen: new Date()
        });
      } catch (error) {
        console.error('Error updating offline status:', error);
      }
    }
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error occurred:', err.stack);
  
  // Handle specific error types
  if (err.name === 'ValidationError') {
    return res.status(400).json({ 
      message: 'Validation Error', 
      error: err.message 
    });
  }
  
  if (err.name === 'CastError') {
    return res.status(400).json({ 
      message: 'Invalid ID format', 
      error: 'Invalid ObjectId' 
    });
  }
  
  if (err.code === 11000) {
    return res.status(400).json({ 
      message: 'Duplicate field value', 
      error: 'Resource already exists' 
    });
  }
  
  res.status(500).json({ 
    message: 'Something went wrong!', 
    error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ message: 'Route not found' });
});

const PORT = process.env.PORT || 5000;

// Start server with error handling
server.listen(PORT, (err) => {
  if (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🌐 Frontend URL: ${process.env.FRONTEND_URL || 'http://localhost:3000'}`);
  console.log(`📁 Upload path: ${process.env.UPLOAD_PATH || './uploads'}`);
});

// Handle server errors
server.on('error', (err) => {
  console.error('Server error:', err);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (err, promise) => {
  console.error('Unhandled Promise Rejection:', err);
  if ((process.env.NODE_ENV || 'development') === 'production') {
    console.log('Shutting down server due to unhandled promise rejection');
    server.close(() => {
      process.exit(1);
    });
  } else {
    console.log('Continuing to run (development mode) despite unhandled rejection');
  }
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  if ((process.env.NODE_ENV || 'development') === 'production') {
    console.log('Shutting down server due to uncaught exception');
    process.exit(1);
  } else {
    console.log('Continuing to run (development mode) despite uncaught exception');
  }
});
