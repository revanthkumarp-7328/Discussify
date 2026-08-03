const express = require('express');
const multer = require('multer');
const path = require('path');
const { body, validationResult } = require('express-validator');
const Message = require('../models/Message');
const User = require('../models/User');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Configure multer for message attachments
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/messages/');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'message-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE) || 5 * 1024 * 1024 // 5MB
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|pdf|doc|docx|txt/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype) || file.mimetype.includes('document') || file.mimetype.includes('text');

    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('File type not allowed'));
    }
  }
});

// @route   POST /api/messages
// @desc    Send a message to another user
// @access  Private
router.post('/', authenticateToken, upload.single('attachment'), [
  body('recipientId')
    .notEmpty()
    .withMessage('Recipient ID is required')
    .isMongoId()
    .withMessage('Valid recipient ID is required'),
  body('content')
    .isLength({ min: 1, max: 1000 })
    .withMessage('Message must be between 1 and 1000 characters')
    .trim()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { recipientId, content } = req.body;

    // Check if recipient exists
    const recipient = await User.findById(recipientId);
    if (!recipient) {
      return res.status(404).json({ message: 'Recipient not found' });
    }

    // Can't send message to yourself
    if (recipientId === req.user._id.toString()) {
      return res.status(400).json({ message: 'Cannot send message to yourself' });
    }

    // Generate conversation ID
    const conversationId = Message.generateConversationId(req.user._id, recipientId);

    // Process attachment if present
    let attachment = null;
    let messageType = 'text';
    
    if (req.file) {
      attachment = {
        filename: req.file.filename,
        originalName: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size,
        path: `/uploads/messages/${req.file.filename}`
      };
      
      if (req.file.mimetype.startsWith('image/')) {
        messageType = 'image';
      } else {
        messageType = 'file';
      }
    }

    // Create message
    const message = new Message({
      sender: req.user._id,
      recipient: recipientId,
      content,
      messageType,
      attachment,
      conversationId
    });

    await message.save();

    // Populate sender details for response
    await message.populate('sender', 'username firstName lastName profilePicture');
    await message.populate('recipient', 'username firstName lastName profilePicture');

    // Emit real-time message if socket.io is available
    if (req.app.get('io')) {
      req.app.get('io').to(`user_${recipientId}`).emit('newMessage', {
        message: message.toObject(),
        conversationId
      });
    }

    res.status(201).json({
      message: 'Message sent successfully',
      data: message
    });
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/messages/conversations
// @desc    Get all conversations for the current user
// @access  Private
router.get('/conversations', authenticateToken, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;

    // Get all conversations where user is sender or recipient
    const conversations = await Message.aggregate([
      {
        $match: {
          $or: [
            { sender: req.user._id },
            { recipient: req.user._id }
          ],
          isDeleted: false
        }
      },
      {
        $sort: { createdAt: -1 }
      },
      {
        $group: {
          _id: '$conversationId',
          lastMessage: { $first: '$$ROOT' },
          unreadCount: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ['$recipient', req.user._id] },
                    { $eq: ['$isRead', false] }
                  ]
                },
                1,
                0
              ]
            }
          }
        }
      },
      {
        $sort: { 'lastMessage.createdAt': -1 }
      },
      {
        $skip: (parseInt(page) - 1) * parseInt(limit)
      },
      {
        $limit: parseInt(limit)
      }
    ]);

    // Populate user details
    await Message.populate(conversations, [
      { path: 'lastMessage.sender', select: 'username firstName lastName profilePicture' },
      { path: 'lastMessage.recipient', select: 'username firstName lastName profilePicture' }
    ]);

    // Format conversations for frontend
    const formattedConversations = conversations.map(conv => {
      const otherUser = conv.lastMessage.sender._id.toString() === req.user._id.toString() 
        ? conv.lastMessage.recipient 
        : conv.lastMessage.sender;

      return {
        conversationId: conv._id,
        otherUser,
        lastMessage: conv.lastMessage,
        unreadCount: conv.unreadCount
      };
    });

    res.json({
      conversations: formattedConversations,
      pagination: {
        currentPage: parseInt(page),
        hasNext: conversations.length === parseInt(limit)
      }
    });
  } catch (error) {
    console.error('Get conversations error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/messages/conversation/:userId
// @desc    Get messages in a conversation with a specific user
// @access  Private
router.get('/conversation/:userId', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const { page = 1, limit = 50 } = req.query;

    // Verify other user exists
    const otherUser = await User.findById(userId).select('username firstName lastName profilePicture');
    if (!otherUser) {
      return res.status(404).json({ message: 'User not found' });
    }

    const conversationId = Message.generateConversationId(req.user._id, userId);

    // Get messages in conversation
    const messages = await Message.find({
      conversationId,
      $nor: [
        { deletedBy: { $elemMatch: { user: req.user._id } } }
      ]
    })
      .populate('sender', 'username firstName lastName profilePicture')
      .populate('recipient', 'username firstName lastName profilePicture')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));

    // Mark messages as read
    await Message.updateMany({
      conversationId,
      recipient: req.user._id,
      isRead: false
    }, {
      isRead: true,
      readAt: new Date()
    });

    res.json({
      messages: messages.reverse(), // Reverse to show oldest first
      otherUser,
      conversationId,
      pagination: {
        currentPage: parseInt(page),
        hasNext: messages.length === parseInt(limit)
      }
    });
  } catch (error) {
    console.error('Get conversation messages error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   PUT /api/messages/:messageId/read
// @desc    Mark a message as read
// @access  Private
router.put('/:messageId/read', authenticateToken, async (req, res) => {
  try {
    const message = await Message.findById(req.params.messageId);

    if (!message) {
      return res.status(404).json({ message: 'Message not found' });
    }

    // Only recipient can mark as read
    if (message.recipient.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied' });
    }

    message.isRead = true;
    message.readAt = new Date();
    await message.save();

    res.json({ message: 'Message marked as read' });
  } catch (error) {
    console.error('Mark message read error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   DELETE /api/messages/:messageId
// @desc    Delete a message (soft delete)
// @access  Private
router.delete('/:messageId', authenticateToken, async (req, res) => {
  try {
    const message = await Message.findById(req.params.messageId);

    if (!message) {
      return res.status(404).json({ message: 'Message not found' });
    }

    // Only sender or recipient can delete
    if (message.sender.toString() !== req.user._id.toString() && 
        message.recipient.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Add user to deletedBy array
    const alreadyDeleted = message.deletedBy.some(deletion => 
      deletion.user.toString() === req.user._id.toString()
    );

    if (!alreadyDeleted) {
      message.deletedBy.push({
        user: req.user._id,
        deletedAt: new Date()
      });

      // If both users have deleted, mark as fully deleted
      if (message.deletedBy.length === 2) {
        message.isDeleted = true;
      }

      await message.save();
    }

    res.json({ message: 'Message deleted successfully' });
  } catch (error) {
    console.error('Delete message error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/messages/unread-count
// @desc    Get unread message count for current user
// @access  Private
router.get('/unread-count', authenticateToken, async (req, res) => {
  try {
    const unreadCount = await Message.countDocuments({
      recipient: req.user._id,
      isRead: false,
      isDeleted: false
    });

    res.json({ unreadCount });
  } catch (error) {
    console.error('Get unread count error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/messages/search-users
// @desc    Search users by username or email to start conversations
// @access  Private
router.get('/search-users', authenticateToken, async (req, res) => {
  try {
    const { query } = req.query;
    
    if (!query || query.trim().length < 2) {
      return res.status(400).json({ message: 'Search query must be at least 2 characters' });
    }

    const searchRegex = new RegExp(query.trim(), 'i');
    
    const users = await User.find({
      $and: [
        { _id: { $ne: req.user._id } }, // Exclude current user
        {
          $or: [
            { username: searchRegex },
            { email: searchRegex },
            { firstName: searchRegex },
            { lastName: searchRegex }
          ]
        }
      ]
    })
    .select('username email firstName lastName profilePicture')
    .limit(10);

    res.json({ users });
  } catch (error) {
    console.error('Search users error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   DELETE /api/messages/conversation/:userId
// @desc    Delete entire conversation with a user
// @access  Private
router.delete('/conversation/:userId', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;
    
    const conversationId = Message.generateConversationId(req.user._id, userId);
    
    // Mark all messages in conversation as deleted for current user
    await Message.updateMany(
      { 
        conversationId,
        deletedBy: { $not: { $elemMatch: { user: req.user._id } } }
      },
      {
        $push: {
          deletedBy: {
            user: req.user._id,
            deletedAt: new Date()
          }
        }
      }
    );

    // Mark messages as fully deleted if both users have deleted them
    await Message.updateMany(
      { 
        conversationId,
        $expr: { $eq: [{ $size: "$deletedBy" }, 2] }
      },
      {
        isDeleted: true
      }
    );

    res.json({ message: 'Conversation deleted successfully' });
  } catch (error) {
    console.error('Delete conversation error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
