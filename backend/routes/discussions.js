const express = require('express');
const multer = require('multer');
const path = require('path');
const { body, validationResult } = require('express-validator');
const mongoose = require('mongoose');
const Discussion = require('../models/Discussion');
const Community = require('../models/Community');
const User = require('../models/User');
const Notification = require('../models/Notification');
const { authenticateToken } = require('../middleware/auth');
const { discussionPhotoUpload, deleteOldImage } = require('../utils/imageUpload');

const router = express.Router();

// Configure multer for discussion attachments
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/discussions/');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'discussion-' + uniqueSuffix + path.extname(file.originalname));
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

// Discussion creation validation
const createDiscussionValidation = [
  body('title')
    .isLength({ min: 5, max: 200 })
    .withMessage('Title must be between 5 and 200 characters')
    .trim(),
  body('content')
    .isLength({ min: 10, max: 5000 })
    .withMessage('Content must be between 10 and 5000 characters')
    .trim(),
  body('communityId')
    .notEmpty()
    .withMessage('Community ID is required')
    .isMongoId()
    .withMessage('Valid community ID is required'),
  body('category')
    .optional()
    .isIn(['General', 'Technology', 'Science', 'Arts', 'Sports', 'Business', 'Education', 'Health', 'Entertainment', 'Other'])
    .withMessage('Invalid category')
];

// @route   POST /api/discussions
// @desc    Create a new discussion
// @access  Private
router.post('/', authenticateToken, discussionPhotoUpload.fields([
  { name: 'profilePhoto', maxCount: 1 },
  { name: 'attachments', maxCount: 5 }
]), createDiscussionValidation, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('Discussion validation errors:', errors.array());
      console.log('Discussion request body:', req.body);
      return res.status(400).json({
        message: 'Validation failed: ' + errors.array().map(err => err.msg).join(', '),
        errors: errors.array()
      });
    }

    const { title, content, communityId, category = 'General', tags = [] } = req.body;

    // Check if community exists
    const community = await Community.findById(communityId);
    if (!community) {
      return res.status(404).json({ message: 'Community not found' });
    }

    // For now, skip membership check to allow discussion creation
    // TODO: Implement proper community membership system
    console.log('Community found:', community.name);
    console.log('User creating discussion:', req.user._id);

    // Process attachments
    const attachments = req.files && req.files.attachments ? req.files.attachments.map(file => ({
      filename: file.filename,
      originalName: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
      path: `/uploads/discussions/${file.filename}`
    })) : [];

    // Process profile photo
    const profilePhoto = req.files && req.files.profilePhoto && req.files.profilePhoto[0] 
      ? `/uploads/discussions/${req.files.profilePhoto[0].filename}` 
      : null;

    // Create discussion
    const discussion = new Discussion({
      title,
      content,
      author: req.user._id,
      community: communityId,
      profilePhoto,
      category,
      tags: Array.isArray(tags) ? tags.map(tag => tag.toLowerCase()) : [],
      attachments,
      isApproved: true // Default to approved for now
    });

    await discussion.save();

    // Update community stats (safely handle missing stats)
    await Community.findByIdAndUpdate(communityId, {
      $inc: { 'stats.discussionCount': 1 }
    }).catch(err => {
      console.log('Stats update failed, continuing...', err.message);
    });

    // Populate author for response
    await discussion.populate('author', 'username firstName lastName profilePicture');

    res.status(201).json({
      message: 'Discussion created successfully',
      discussion
    });
  } catch (error) {
    console.error('Create discussion error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/discussions
// @desc    Get discussions with filters (only from communities where user is a member)
// @access  Private
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { 
      communityId,
      page = 1, 
      limit = 10,
      category,
      search,
      sortBy = 'lastActivity',
      sortOrder = 'desc'
    } = req.query;

    // First, get all communities where the user is a member (with roles)
    const userCommunities = await Community.find({
      'members.user': req.user._id
    }).select('_id members');

    const userCommunityIds = userCommunities.map(community => community._id);

    const query = { 
      isApproved: true,
      community: { $in: userCommunityIds } // Only show discussions from user's communities
    };

    if (communityId) {
      // Verify user has access to the specific community
      const community = await Community.findById(communityId);
      if (!community) {
        return res.status(404).json({ message: 'Community not found' });
      }

      const isMember = community.members.some(member => 
        member.user.toString() === req.user._id.toString()
      );
      
      if (!isMember) {
        return res.status(403).json({ message: 'Access denied - you are not a member of this community' });
      }

      query.community = communityId;
    }

    if (category) {
      query.category = category;
    }

    if (search) {
      const searchRegex = new RegExp(search, 'i');
      query.$or = [
        { title: searchRegex },
        { content: searchRegex },
        { tags: { $in: [searchRegex] } }
      ];
    }

    const sortOptions = {};
    sortOptions[sortBy] = sortOrder === 'desc' ? -1 : 1;

    const discussions = await Discussion.find(query)
      .populate('author', 'username firstName lastName profilePicture')
      .populate('community', 'name')
      .sort(sortOptions)
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit))
      .lean({ virtuals: true });

    const total = await Discussion.countDocuments(query);

    // Build a map of communityId -> role for current user
    const roleMap = new Map();
    for (const c of userCommunities) {
      const member = (c.members || []).find(m => m.user.toString() === req.user._id.toString());
      if (member) roleMap.set(c._id.toString(), member.role);
    }

    // Attach permission flags to each discussion
    const decorated = discussions.map(d => {
      const communityId = (d.community && (d.community._id || d.community)) ? (d.community._id || d.community).toString() : null;
      const userRoleInCommunity = communityId ? roleMap.get(communityId) : null;
      const isCommunityAdmin = userRoleInCommunity === 'admin';
      const isOwner = d.author && ((d.author._id || d.author).toString() === req.user._id.toString());
      const canManage = isOwner || req.user.role === 'admin' || isCommunityAdmin;
      return { ...d, permissions: { isOwner, isCommunityAdmin, canManage } };
    });

    res.json({
      discussions: decorated,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / parseInt(limit)),
        totalDiscussions: total,
        hasNext: parseInt(page) < Math.ceil(total / parseInt(limit)),
        hasPrev: parseInt(page) > 1
      }
    });
  } catch (error) {
    console.error('Get discussions error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/discussions/:id
// @desc    Get discussion by ID
// @access  Private
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const discussion = await Discussion.findById(req.params.id)
      .populate('author', 'username firstName lastName profilePicture')
      .populate('community', 'name isPrivate members')
      .populate('replies.author', 'username firstName lastName profilePicture')
      .populate('likes.user', 'username firstName lastName')
      .populate('views.user', 'username');

    if (!discussion) {
      return res.status(404).json({ message: 'Discussion not found' });
    }

    // Check access to private community
    if (discussion.community.isPrivate) {
      const isMember = discussion.community.members.some(member => 
        member.user.toString() === req.user._id.toString()
      );
      
      if (!isMember) {
        return res.status(403).json({ message: 'Access denied to private community discussion' });
      }
    }

    // Add view if not already viewed by user
    const hasViewed = discussion.views.some(view => 
      view.user.toString() === req.user._id.toString()
    );

    if (!hasViewed) {
      discussion.views.push({
        user: req.user._id,
        viewedAt: new Date()
      });
      await discussion.save();

      // Emit view count update to community room
      try {
        const io = req.app.get('io');
        const communityId = discussion.community?._id || discussion.community;
        io.to(`community-${communityId}`).emit('discussion-stats-updated', {
          discussionId: discussion._id.toString(),
          viewCount: discussion.views.length
        });
      } catch (e) {
        console.warn('Socket emit failed for view update:', e.message);
      }
    }

    res.json({ discussion });
  } catch (error) {
    console.error('Get discussion error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/discussions/:id/reply
// @desc    Add reply to discussion
// @access  Private
router.post('/:id/reply', authenticateToken, upload.array('attachments', 3), [
  body('content')
    .isLength({ min: 1, max: 2000 })
    .withMessage('Reply content must be between 1 and 2000 characters')
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

    const { content } = req.body;
    const discussion = await Discussion.findById(req.params.id)
      .populate('community', 'members isPrivate');

    if (!discussion) {
      return res.status(404).json({ message: 'Discussion not found' });
    }

    if (discussion.isLocked) {
      return res.status(403).json({ message: 'Discussion is locked' });
    }

    // Check if user is member of community
    const isMember = discussion.community.members.some(member => 
      member.user.toString() === req.user._id.toString()
    );

    if (!isMember) {
      return res.status(403).json({ message: 'You must be a member to reply' });
    }

    // Process attachments
    const attachments = req.files ? req.files.map(file => ({
      filename: file.filename,
      originalName: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
      path: `/uploads/discussions/${file.filename}`
    })) : [];

    // Add reply
    const reply = {
      author: req.user._id,
      content,
      attachments,
      createdAt: new Date()
    };

    discussion.replies.push(reply);
    discussion.lastActivity = new Date();
    await discussion.save();

    // Populate the new reply
    await discussion.populate('replies.author', 'username firstName lastName profilePicture');

    const newReply = discussion.replies[discussion.replies.length - 1];

    // Emit reply count update
    try {
      const io = req.app.get('io');
      const communityId = discussion.community?._id || discussion.community;
      io.to(`community-${communityId}`).emit('discussion-stats-updated', {
        discussionId: discussion._id.toString(),
        replyCount: discussion.replies.length,
        lastActivity: discussion.lastActivity
      });
    } catch (e) {
      console.warn('Socket emit failed for reply add:', e.message);
    }

    res.status(201).json({
      message: 'Reply added successfully',
      reply: newReply
    });
  } catch (error) {
    console.error('Add reply error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/discussions/:id/like
// @desc    Like/unlike a discussion
// @access  Private
router.post('/:id/like', authenticateToken, async (req, res) => {
  try {
    const discussion = await Discussion.findById(req.params.id);

    if (!discussion) {
      return res.status(404).json({ message: 'Discussion not found' });
    }

    const likeIndex = discussion.likes.findIndex(like => 
      like.user.toString() === req.user._id.toString()
    );

    if (likeIndex > -1) {
      // Unlike
      discussion.likes.splice(likeIndex, 1);
      await discussion.save();

      // Emit like count update
      try {
        const io = req.app.get('io');
        const communityId = discussion.community?._id || discussion.community;
        io.to(`community-${communityId}`).emit('discussion-stats-updated', {
          discussionId: discussion._id.toString(),
          likeCount: discussion.likes.length
        });
      } catch (e) {
        console.warn('Socket emit failed for like update:', e.message);
      }

      res.json({ message: 'Discussion unliked', liked: false, likeCount: discussion.likes.length });
    } else {
      // Like
      discussion.likes.push({
        user: req.user._id,
        likedAt: new Date()
      });
      await discussion.save();

      // Emit like count update
      try {
        const io = req.app.get('io');
        const communityId = discussion.community?._id || discussion.community;
        io.to(`community-${communityId}`).emit('discussion-stats-updated', {
          discussionId: discussion._id.toString(),
          likeCount: discussion.likes.length
        });
      } catch (e) {
        console.warn('Socket emit failed for like update:', e.message);
      }

      res.json({ message: 'Discussion liked', liked: true, likeCount: discussion.likes.length });
    }
  } catch (error) {
    console.error('Like discussion error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/discussions/:discussionId/replies/:replyId/like
// @desc    Like/unlike a reply
// @access  Private
router.post('/:discussionId/replies/:replyId/like', authenticateToken, async (req, res) => {
  try {
    const discussion = await Discussion.findById(req.params.discussionId);

    if (!discussion) {
      return res.status(404).json({ message: 'Discussion not found' });
    }

    const reply = discussion.replies.id(req.params.replyId);
    if (!reply) {
      return res.status(404).json({ message: 'Reply not found' });
    }

    const likeIndex = reply.likes.findIndex(like => 
      like.user.toString() === req.user._id.toString()
    );

    if (likeIndex > -1) {
      // Unlike
      reply.likes.splice(likeIndex, 1);
    } else {
      // Like
      reply.likes.push({
        user: req.user._id,
        likedAt: new Date()
      });
    }

    await discussion.save();
    res.json({ 
      message: likeIndex > -1 ? 'Reply unliked' : 'Reply liked',
      liked: likeIndex === -1
    });
  } catch (error) {
    console.error('Like reply error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   PUT /api/discussions/:id
// @desc    Update discussion
// @access  Private
router.put('/:id', authenticateToken, [
  body('title')
    .optional()
    .isLength({ min: 5, max: 200 })
    .withMessage('Title must be between 5 and 200 characters')
    .trim(),
  body('content')
    .optional()
    .isLength({ min: 10, max: 5000 })
    .withMessage('Content must be between 10 and 5000 characters')
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

    const discussion = await Discussion.findById(req.params.id);

    if (!discussion) {
      return res.status(404).json({ message: 'Discussion not found' });
    }

    // Check if user is author or has moderator permissions
    if (discussion.author.toString() !== req.user._id.toString()) {
      const community = await Community.findById(discussion.community);
      const userMember = community.members.find(member => 
        member.user.toString() === req.user._id.toString()
      );

      if (!userMember || !['admin', 'moderator'].includes(userMember.role)) {
        return res.status(403).json({ message: 'You can only edit your own discussions' });
      }
    }

    const { title, content, tags } = req.body;

    if (title) discussion.title = title;
    if (content) discussion.content = content;
    if (tags) discussion.tags = tags.map(tag => tag.toLowerCase());

    discussion.isEdited = true;
    discussion.editedAt = new Date();

    await discussion.save();

    res.json({
      message: 'Discussion updated successfully',
      discussion
    });
  } catch (error) {
    console.error('Update discussion error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   DELETE /api/discussions/:id
// @desc    Delete discussion
// @access  Private
router.delete('/:id', authenticateToken, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    console.log(`[${new Date().toISOString()}] Delete discussion - User: ${req.user._id}, Discussion: ${req.params.id}`);
    
    const discussion = await Discussion.findById(req.params.id).session(session);

    if (!discussion) {
      console.error(`Discussion not found: ${req.params.id}`);
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ 
        success: false,
        message: 'Discussion not found' 
      });
    }

    // Authorization: author, site admin, or community admin can delete
    if (discussion.author.toString() !== req.user._id.toString()) {
      // Site admin bypass
      if (req.user.role !== 'admin') {
        const community = await Community.findById(discussion.community).session(session);
        
        if (!community) {
          console.error(`Community not found for discussion: ${discussion._id}`);
          await session.abortTransaction();
          session.endSession();
          return res.status(404).json({ 
            success: false,
            message: 'Community not found' 
          });
        }
        
        const userMember = community.members.find(member => 
          member.user.toString() === req.user._id.toString()
        );

        if (!userMember || userMember.role !== 'admin') {
          await session.abortTransaction();
          session.endSession();
          return res.status(403).json({ 
            success: false,
            message: 'Only the author or a community admin can delete this discussion' 
          });
        }
      }
    }

    // Delete the discussion
    await Discussion.findByIdAndDelete(req.params.id).session(session);

    // Update community stats
    await Community.findByIdAndUpdate(
      discussion.community,
      { $inc: { 'stats.discussionCount': -1 } },
      { session }
    );

    // Remove from users' bookmarks
    await User.updateMany(
      { bookmarkedDiscussions: req.params.id },
      { $pull: { bookmarkedDiscussions: req.params.id } },
      { session }
    );

    await session.commitTransaction();
    session.endSession();

    console.log(`Successfully deleted discussion: ${req.params.id}`);
    
    res.json({ 
      success: true,
      message: 'Discussion deleted successfully' 
    });
    
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    
    const errorDetails = {
      timestamp: new Date().toISOString(),
      userId: req.user?._id,
      discussionId: req.params.id,
      error: error.message,
      stack: error.stack,
      requestBody: req.body
    };
    
    console.error('Delete discussion error:', JSON.stringify(errorDetails, null, 2));
    
    let statusCode = 500;
    let errorMessage = 'Failed to delete discussion. Please try again later.';
    
    if (error.name === 'CastError') {
      statusCode = 400;
      errorMessage = 'Invalid discussion ID format';
    }
    
    res.status(statusCode).json({ 
      success: false,
      message: errorMessage,
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// @route   GET /api/discussions/:id/replies
// @desc    Get all replies for a discussion
// @access  Private
router.get('/:id/replies', authenticateToken, async (req, res) => {
  try {
    const discussion = await Discussion.findById(req.params.id)
      .select('replies')
      .populate({
        path: 'replies.author',
        select: 'firstName lastName profilePicture username'
      })
      .populate({
        path: 'replies.likes.user',
        select: 'firstName lastName'
      });

    if (!discussion) {
      return res.status(404).json({ message: 'Discussion not found' });
    }

    // Sort replies by creation date (newest first)
    const sortedReplies = discussion.replies.sort((a, b) => b.createdAt - a.createdAt);
    
    res.json({ replies: sortedReplies });
  } catch (error) {
    console.error('Error fetching replies:', error);
    res.status(500).json({ message: 'Server error while fetching replies' });
  }
});

// @route   POST /api/discussions/:id/replies
// @desc    Add a reply to a discussion
// @access  Private
router.post('/:id/replies', authenticateToken, [
  body('content')
    .trim()
    .isLength({ min: 1, max: 2000 })
    .withMessage('Reply must be between 1 and 2000 characters')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { content } = req.body;
    const discussion = await Discussion.findById(req.params.id);

    if (!discussion) {
      return res.status(404).json({ message: 'Discussion not found' });
    }

    const newReply = {
      author: req.user._id,
      content,
      createdAt: new Date()
    };

    discussion.replies.push(newReply);
    await discussion.save();

    // Populate author details for the response
    await discussion.populate({
      path: 'replies.author',
      match: { _id: req.user._id },
      select: 'firstName lastName profilePicture username'
    });

    const addedReply = discussion.replies[discussion.replies.length - 1];
    
    res.status(201).json({ 
      message: 'Reply added successfully',
      reply: addedReply.toObject()
    });
  } catch (error) {
    console.error('Error adding reply:', error);
    res.status(500).json({ message: 'Server error while adding reply' });
  }
});

// @route   PUT /api/discussions/:discussionId/replies/:replyId
// @desc    Update a reply
// @access  Private
router.put('/:discussionId/replies/:replyId', authenticateToken, [
  body('content')
    .trim()
    .isLength({ min: 1, max: 2000 })
    .withMessage('Reply must be between 1 and 2000 characters')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { content } = req.body;
    const discussion = await Discussion.findById(req.params.discussionId);

    if (!discussion) {
      return res.status(404).json({ message: 'Discussion not found' });
    }

    const reply = discussion.replies.id(req.params.replyId);
    if (!reply) {
      return res.status(404).json({ message: 'Reply not found' });
    }

    // Check if the user is the author of the reply
    if (reply.author.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized to update this reply' });
    }

    reply.content = content;
    reply.isEdited = true;
    reply.editedAt = new Date();
    
    await discussion.save();
    
    res.json({ 
      message: 'Reply updated successfully',
      reply: reply.toObject()
    });
  } catch (error) {
    console.error('Error updating reply:', error);
    res.status(500).json({ message: 'Server error while updating reply' });
  }
});

// @route   DELETE /api/discussions/:discussionId/replies/:replyId
// @desc    Delete a reply
// @access  Private
router.delete('/:discussionId/replies/:replyId', authenticateToken, async (req, res) => {
  try {
    const discussion = await Discussion.findById(req.params.discussionId);

    if (!discussion) {
      return res.status(404).json({ message: 'Discussion not found' });
    }

    const reply = discussion.replies.id(req.params.replyId);
    if (!reply) {
      return res.status(404).json({ message: 'Reply not found' });
    }

    // Check if the user is the author of the reply or an admin/moderator
    if (reply.author.toString() !== req.user._id.toString() && 
        req.user.role !== 'admin' && 
        req.user.role !== 'moderator') {
      return res.status(403).json({ message: 'Not authorized to delete this reply' });
    }

    discussion.replies.pull({ _id: req.params.replyId });
    await discussion.save();

    // Emit reply count update
    try {
      const io = req.app.get('io');
      const communityId = discussion.community?._id || discussion.community;
      io.to(`community-${communityId}`).emit('discussion-stats-updated', {
        discussionId: discussion._id.toString(),
        replyCount: discussion.replies.length,
        lastActivity: discussion.lastActivity
      });
    } catch (e) {
      console.warn('Socket emit failed for reply delete:', e.message);
    }

    res.json({ message: 'Reply deleted successfully' });
  } catch (error) {
    console.error('Error deleting reply:', error);
    res.status(500).json({ message: 'Server error while deleting reply' });
  }
});

// @route   POST /api/discussions/:discussionId/replies/:replyId/like
// @desc    Like or unlike a reply
// @access  Private
router.post('/:discussionId/replies/:replyId/like', authenticateToken, async (req, res) => {
  try {
    const discussion = await Discussion.findById(req.params.discussionId);

    if (!discussion) {
      return res.status(404).json({ message: 'Discussion not found' });
    }

    const reply = discussion.replies.id(req.params.replyId);
    if (!reply) {
      return res.status(404).json({ message: 'Reply not found' });
    }

    // Check if user already liked the reply
    const likeIndex = reply.likes.findIndex(
      like => like.user.toString() === req.user._id.toString()
    );

    if (likeIndex === -1) {
      // Add like
      reply.likes.push({ user: req.user._id });
      await discussion.save();
      
      return res.json({ 
        message: 'Reply liked successfully',
        action: 'liked',
        likeCount: reply.likes.length
      });
    } else {
      // Remove like
      reply.likes.splice(likeIndex, 1);
      await discussion.save();
      
      return res.json({ 
        message: 'Reply unliked successfully',
        action: 'unliked',
        likeCount: reply.likes.length
      });
    }
  } catch (error) {
    console.error('Error toggling reply like:', error);
    res.status(500).json({ message: 'Server error while toggling reply like' });
  }
});

// @route   POST /api/discussions/:id/profile-photo
// @desc    Upload discussion profile photo
// @access  Private
router.post('/:id/profile-photo', authenticateToken, discussionPhotoUpload.single('profilePhoto'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No image file provided' });
    }

    const discussion = await Discussion.findById(req.params.id);
    if (!discussion) {
      return res.status(404).json({ message: 'Discussion not found' });
    }

    // Check if user is the author of the discussion
    if (discussion.author.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied - only the author can update the discussion photo' });
    }

    // Delete old profile photo if exists
    if (discussion.profilePhoto) {
      const oldPhotoPath = discussion.profilePhoto.replace('/uploads/', 'uploads/');
      deleteOldImage(oldPhotoPath);
    }

    // Update discussion with new profile photo
    discussion.profilePhoto = `/uploads/discussions/${req.file.filename}`;
    await discussion.save();

    res.json({
      message: 'Profile photo updated successfully',
      profilePhoto: discussion.profilePhoto
    });
  } catch (error) {
    console.error('Upload discussion profile photo error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
