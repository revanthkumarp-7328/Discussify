const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const { body, validationResult } = require('express-validator');
const Community = require('../models/Community');
const User = require('../models/User');
const Notification = require('../models/Notification');
const Discussion = require('../models/Discussion');
const Resource = require('../models/Resource');
const { authenticateToken, requireAdmin, requireModerator } = require('../middleware/auth');
const { communityPhotoUpload, deleteOldImage } = require('../utils/imageUpload');

const router = express.Router();

// Configure multer for community cover images
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/communities/');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'community-' + uniqueSuffix + path.extname(file.originalname));
  }
});

// @route   GET /api/communities/invitations
// @desc    Get pending community invitations for the current user
// @access  Private
router.get('/invitations', authenticateToken, async (req, res) => {
  try {
    const communities = await Community.find({
      invitations: {
        $elemMatch: { user: req.user._id, status: 'pending' }
      }
    })
      .select('name profilePhoto coverImage isPrivate invitations creator')
      .populate('creator', 'username firstName lastName profilePicture');

    // Flatten invitations for the current user
    const invitations = [];
    communities.forEach((community) => {
      community.invitations
        .filter((inv) => inv.user.toString() === req.user._id.toString() && inv.status === 'pending')
        .forEach((inv) => {
          invitations.push({
            community: {
              _id: community._id,
              name: community.name,
              profilePhoto: community.profilePhoto,
              coverImage: community.coverImage,
              isPrivate: community.isPrivate,
              creator: community.creator
            },
            invitedAt: inv.invitedAt,
            invitedBy: inv.invitedBy,
            status: inv.status
          });
        });
    });

    res.json({ success: true, invitations });
  } catch (error) {
    console.error('Get invitations error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   POST /api/communities/:id/invitations/accept
// @desc    Accept a community invitation
// @access  Private
router.post('/:id/invitations/accept', authenticateToken, async (req, res) => {
  try {
    const community = await Community.findById(req.params.id);
    if (!community) {
      return res.status(404).json({ success: false, message: 'Community not found' });
    }

    // Idempotency & checks
    const isMember = community.members?.some(m => m.user.toString() === req.user._id.toString());
    const invitation = (community.invitations || []).find(
      (inv) => inv.user.toString() === req.user._id.toString() && inv.status === 'pending'
    );
    if (!invitation && isMember) {
      // Already a member; treat as success
      return res.json({ success: true, message: 'You are already a member of this community.' });
    }
    if (!invitation) {
      // Gracefully handle missing pending invitation
      return res.json({ success: true, message: 'No pending invitation found. Nothing to accept.' });
    }

    // Update invitation status and add as member
    invitation.status = 'accepted';
    if (!isMember) {
      community.members.push({ user: req.user._id, role: 'member' });
    }
    await community.save();

    await User.findByIdAndUpdate(req.user._id, { $addToSet: { communities: community._id } });

    // Notify community creator
    await Notification.create({
      recipient: community.creator,
      sender: req.user._id,
      type: 'community_join',
      title: 'Invitation Accepted',
      message: `${req.user.firstName} ${req.user.lastName} accepted your invite to ${community.name}`,
      relatedEntity: { entityType: 'Community', entityId: community._id },
      isRead: false,
      priority: 'low'
    });

    res.json({ success: true, message: 'Invitation accepted. You have joined the community.' });
  } catch (error) {
    console.error('Accept invitation error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// @route   POST /api/communities/:id/invitations/decline
// @desc    Decline a community invitation
// @access  Private
router.post('/:id/invitations/decline', authenticateToken, async (req, res) => {
  try {
    const community = await Community.findById(req.params.id);
    if (!community) {
      return res.status(404).json({ success: false, message: 'Community not found' });
    }

    // Find pending invitation for this user
    const invitation = (community.invitations || []).find(
      (inv) => inv.user.toString() === req.user._id.toString() && inv.status === 'pending'
    );
    if (!invitation) {
      // Gracefully handle missing pending invitation
      return res.json({ success: true, message: 'No pending invitation found. Nothing to decline.' });
    }

    // Update invitation status
    invitation.status = 'declined';
    await community.save();

    // Notify community creator
    await Notification.create({
      recipient: community.creator,
      sender: req.user._id,
      type: 'system',
      title: 'Invitation Declined',
      message: `${req.user.firstName} ${req.user.lastName} declined your invite to ${community.name}`,
      relatedEntity: { entityType: 'Community', entityId: community._id },
      isRead: false,
      priority: 'low'
    });

    res.json({ success: true, message: 'Invitation declined.' });
  } catch (error) {
    console.error('Decline invitation error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE) || 5 * 1024 * 1024 // 5MB
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

// Community creation validation
const createCommunityValidation = [
  body('name')
    .isLength({ min: 3, max: 100 })
    .withMessage('Community name must be between 3 and 100 characters')
    .trim(),
  body('description')
    .isLength({ min: 10, max: 1000 })
    .withMessage('Description must be between 10 and 1000 characters')
    .trim(),
  body('category')
    .isIn(['Technology', 'Science', 'Arts', 'Sports', 'Business', 'Education', 'Health', 'Entertainment', 'Other'])
    .withMessage('Invalid category'),
  body('isPrivate')
    .optional()
    .isBoolean()
    .withMessage('isPrivate must be a boolean')
];

// @route   POST /api/communities
// @desc    Create a new community
// @access  Private
router.post('/', authenticateToken, communityPhotoUpload.single('profilePhoto'), createCommunityValidation, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { name, description, category, isPrivate = false, tags } = req.body;

    // Normalize tags into an array of strings
    let tagsArray = [];
    if (Array.isArray(tags)) {
      tagsArray = tags;
    } else if (typeof tags === 'string') {
      try {
        const parsed = JSON.parse(tags);
        if (Array.isArray(parsed)) {
          tagsArray = parsed;
        } else {
          tagsArray = tags
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        }
      } catch (e) {
        tagsArray = tags
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      }
    } else {
      tagsArray = [];
    }

    // Check if community name already exists
    const existingCommunity = await Community.findOne({ 
      name: { $regex: new RegExp(`^${name}$`, 'i') } 
    });

    if (existingCommunity) {
      return res.status(400).json({ message: 'A community with this name already exists' });
    }

    // Create new community
    const community = new Community({
      name,
      description,
      category,
      isPrivate,
      tags: tagsArray.map(tag => tag.toLowerCase()),
      creator: req.user._id,
      profilePhoto: req.file ? `/uploads/communities/${req.file.filename}` : null,
      members: [{
        user: req.user._id,
        role: 'admin',
        joinedAt: new Date()
      }],
      moderators: [req.user._id]
    });

    await community.save();

    // Add community to user's communities list
    await User.findByIdAndUpdate(req.user._id, {
      $push: { communities: community._id }
    });

    // Populate creator and members for response
    await community.populate('creator', 'username firstName lastName profilePicture');
    await community.populate('members.user', 'username firstName lastName profilePicture');

    res.status(201).json({
      message: 'Community created successfully',
      community
    });
  } catch (error) {
    console.error('Create community error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/communities
// @desc    Get all communities (with pagination and filters)
// @access  Private
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 10, 
      category, 
      search, 
      isPrivate,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    const query = { isActive: true };

    // Apply filters
    if (category) {
      query.category = category;
    }

    if (isPrivate !== undefined) {
      query.isPrivate = isPrivate === 'true';
    }

    if (search) {
      const searchRegex = new RegExp(search, 'i');
      query.$or = [
        { name: searchRegex },
        { description: searchRegex },
        { tags: { $in: [searchRegex] } }
      ];
    }

    // Show all communities - users can see private communities but can't join without approval

    const sortOptions = {};
    sortOptions[sortBy] = sortOrder === 'desc' ? -1 : 1;

    const communities = await Community.find(query)
      .populate('creator', 'username firstName lastName profilePicture')
      .populate('members.user', 'username firstName lastName profilePicture')
      .sort(sortOptions)
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));

    // Add isMember field and request status to each community
    const communitiesWithMembership = communities.map(community => {
      const communityObj = community.toObject();
      communityObj.isMember = community.members.some(member => 
        member.user._id.toString() === req.user._id.toString()
      );
      
      // Check if user has pending join request
      communityObj.hasPendingRequest = community.joinRequests.some(request => 
        request.user._id.toString() === req.user._id.toString() && request.status === 'pending'
      );
      
      // Add member count to stats
      if (!communityObj.stats) {
        communityObj.stats = {};
      }
      communityObj.stats.memberCount = community.members.length;
      
      return communityObj;
    });

    const total = await Community.countDocuments(query);

    res.json({
      communities: communitiesWithMembership,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / parseInt(limit)),
        totalCommunities: total,
        hasNext: parseInt(page) < Math.ceil(total / parseInt(limit)),
        hasPrev: parseInt(page) > 1
      }
    });
  } catch (error) {
    console.error('Get communities error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/communities/my
// @desc    Get communities created by or joined by current user
// @access  Private
router.get('/my', authenticateToken, async (req, res) => {
  try {
    const { limit = 100, search } = req.query;
    const query = {
      isActive: true,
      $or: [
        { creator: req.user._id },
        { 'members.user': req.user._id }
      ]
    };

    if (search) {
      query.name = { $regex: search, $options: 'i' };
    }

    const communities = await Community.find(query)
      .select('_id name isPrivate stats creator')
      .sort({ name: 1 })
      .limit(parseInt(limit));

    res.json({ communities });
  } catch (error) {
    console.error('Get my communities error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/communities/:id
// @desc    Get community by ID
// @access  Private
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const community = await Community.findById(req.params.id)
      .populate('creator', 'username firstName lastName profilePicture')
      .populate('members.user', 'username firstName lastName profilePicture')
      .populate('moderators', 'username firstName lastName profilePicture');

    if (!community) {
      return res.status(404).json({ message: 'Community not found' });
    }

    // Check if user has access to private community
    if (community.isPrivate) {
      const isMember = community.members.some(member => 
        member.user._id.toString() === req.user._id.toString()
      );
      
      if (!isMember) {
        return res.status(403).json({ message: 'Access denied to private community' });
      }
    }

    res.json({ community });
  } catch (error) {
    console.error('Get community error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/communities/:id/join
// @desc    Join a community or request to join private community
// @access  Private
router.post('/:id/join', authenticateToken, async (req, res) => {
  try {
    const { message } = req.body;
    const community = await Community.findById(req.params.id)
      .populate('creator', 'firstName lastName');
    
    if (!community) {
      return res.status(404).json({ message: 'Community not found' });
    }

    // Check if user is already a member
    const isMember = community.members.some(member => 
      member.user.toString() === req.user._id.toString()
    );

    if (isMember) {
      return res.status(400).json({ message: 'You are already a member of this community' });
    }

    // Check if user already has a pending request
    const existingRequest = community.joinRequests.find(request => 
      request.user.toString() === req.user._id.toString() && request.status === 'pending'
    );

    if (existingRequest) {
      return res.status(400).json({ message: 'You already have a pending join request' });
    }

    // If community is private, create join request
    if (community.isPrivate) {
      // Create a join request subdocument and capture its _id
      const joinRequest = {
        user: req.user._id,
        message: message || '',
        status: 'pending'
      };
      community.joinRequests.push(joinRequest);

      await community.save();

      const requestId = community.joinRequests[community.joinRequests.length - 1]._id;

      // Create notification for community creator/admins (with actionUrl for approval)
      const Notification = require('../models/Notification');
      await Notification.create({
        recipient: community.creator._id,
        sender: req.user._id,
        type: 'join_request',
        title: 'New Join Request',
        message: `${req.user.firstName} ${req.user.lastName} wants to join ${community.name}`,
        relatedEntity: { entityType: 'Community', entityId: community._id },
        isRead: false,
        priority: 'medium',
        actionUrl: `/api/communities/${community._id}/join-requests/${requestId}/approve`
      });

      return res.json({ message: 'Join request sent successfully. You will be notified when approved.' });
    }

    // For public communities, join immediately
    community.members.push({
      user: req.user._id,
      role: 'member'
    });

    await community.save();

    // Add community to user's communities list
    await User.findByIdAndUpdate(req.user._id, {
      $addToSet: { communities: community._id }
    });

    res.json({ message: 'Successfully joined the community' });
  } catch (error) {
    console.error('Join community error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   DELETE /api/communities/:id/cancel-request
// @desc    Cancel pending join request
// @access  Private
router.delete('/:id/cancel-request', authenticateToken, async (req, res) => {
  try {
    console.log(`[${new Date().toISOString()}] Cancel join request - User: ${req.user._id}, Community: ${req.params.id}`);
    
    // Find the community with the join request
    const community = await Community.findById(req.params.id)
      .select('joinRequests name')
      .populate({
        path: 'joinRequests.user',
        select: '_id',
        model: 'User'
      });
    
    if (!community) {
      console.error(`Community not found: ${req.params.id}`);
      return res.status(404).json({ 
        success: false,
        message: 'Community not found' 
      });
    }

    // Find the pending request
    const requestIndex = community.joinRequests.findIndex(request => {
      return request.user && 
        request.user._id && 
             request.user._id.toString() === req.user._id.toString() && 
             request.status === 'pending';
    });

    if (requestIndex === -1) {
      console.log(`No pending request found for user ${req.user._id} in community ${community._id}`);
      return res.status(404).json({ 
        success: false,
        message: 'No pending join request found or request already processed' 
      });
    }

    // Remove the request from community
    community.joinRequests.splice(requestIndex, 1);
    await community.save();
    
    // Remove community from user's requestedCommunities array
    await User.findByIdAndUpdate(
      req.user._id,
      { $pull: { requestedCommunities: community._id } }
    );

    console.log(`Successfully cancelled join request - User: ${req.user._id}, Community: ${community._id}`);
    
    res.json({ 
      success: true,
      message: 'Join request cancelled successfully',
      communityId: community._id
    });
    
  } catch (error) {
    console.error('Error cancelling join request:', {
      timestamp: new Date().toISOString(),
      userId: req.user?._id,
      communityId: req.params.id,
      error: error.message,
      stack: error.stack,
      requestBody: req.body
    });
    
    res.status(500).json({ 
      success: false,
      message: 'Failed to cancel join request',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// @route   POST /api/communities/:id/leave
// @desc    Leave a community
// @access  Private
router.post('/:id/leave', authenticateToken, async (req, res) => {
  try {
    const community = await Community.findById(req.params.id);

    if (!community) {
      return res.status(404).json({ message: 'Community not found' });
    }

    // Check if user is a member
    const memberIndex = community.members.findIndex(member => 
      member.user.toString() === req.user._id.toString()
    );

    if (memberIndex === -1) {
      return res.status(400).json({ message: 'You are not a member of this community' });
    }

    // Check if user is the creator
    if (community.creator.toString() === req.user._id.toString()) {
      return res.status(400).json({ message: 'Community creator cannot leave. Transfer ownership or delete the community.' });
    }

    // Remove user from community members
    community.members.splice(memberIndex, 1);

    // Remove from moderators if applicable
    community.moderators = community.moderators.filter(mod => 
      mod.toString() !== req.user._id.toString()
    );

    await community.save();

    // Remove community from user's communities list
    await User.findByIdAndUpdate(req.user._id, {
      $pull: { communities: community._id }
    });

    res.json({ message: 'Successfully left the community' });
  } catch (error) {
    console.error('Leave community error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/communities/:id/invite
// @desc    Invite user to community by username
// @access  Private
router.post('/:id/invite', authenticateToken, [
  body('username').notEmpty().withMessage('Username is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false,
        message: 'Validation error',
        errors: errors.array() 
      });
    }

    const { username } = req.body;
    const community = await Community.findById(req.params.id);

    if (!community) {
      return res.status(404).json({ 
        success: false,
        message: 'Community not found' 
      });
    }

    // Check permissions: community creator or community admin/moderator
    const isCreator = community.creator.toString() === req.user._id.toString();
    const isCommunityAdminOrMod = community.members.some(member => 
      member.user.toString() === req.user._id.toString() && 
      (member.role === 'admin' || member.role === 'moderator')
    );

    if (!isCreator && !isCommunityAdminOrMod) {
      return res.status(403).json({ 
        success: false,
        message: 'You do not have permission to invite users' 
      });
    }

    // Find user by username (case insensitive search)
    const User = require('../models/User');
    const userToInvite = await User.findOne({ 
      username: { $regex: new RegExp('^' + username + '$', 'i') } 
    });
    
    if (!userToInvite) {
      return res.status(404).json({ 
        success: false,
        message: 'User not found. Please check the username and try again.' 
      });
    }

    // Check if user is already a member
    const isAlreadyMember = community.members.some(member => 
      member.user.toString() === userToInvite._id.toString()
    );
    
    if (isAlreadyMember) {
      return res.status(400).json({ 
        success: false,
        message: 'This user is already a member of the community' 
      });
    }

    // Check if a pending invitation already exists (idempotent: refresh instead of blocking)
    const existingInvitation = community.invitations?.find(inv => 
      inv.user.toString() === userToInvite._id.toString() && inv.status === 'pending'
    );
    
    if (existingInvitation) {
      existingInvitation.invitedAt = new Date();
      existingInvitation.invitedBy = req.user._id;
      await community.save();

      // Re-notify the invited user
      const Notification = require('../models/Notification');
      await Notification.create({
        recipient: userToInvite._id,
        sender: req.user._id,
        type: 'community_invite',
        title: 'Community Invitation',
        message: `You've been invited to join the community "${community.name}"`,
        relatedEntity: {
          entityType: 'Community',
          entityId: community._id
        },
        isRead: false,
        priority: 'medium',
        actionUrl: `/api/communities/${community._id}/invitations/accept`
      });

      return res.json({ 
        success: true,
        message: `Invitation refreshed for @${userToInvite.username}`
      });
    }

    try {
      // Add invitation
      community.invitations = community.invitations || [];
      community.invitations.push({
        user: userToInvite._id,
        invitedBy: req.user._id,
        invitedAt: new Date(),
        status: 'pending'
      });

      // Save community with new invitation
      await community.save();

      // Create notification for the invited user
      const Notification = require('../models/Notification');
      await Notification.create({
        recipient: userToInvite._id,
        sender: req.user._id,
        type: 'community_invite',
        title: 'Community Invitation',
        message: `You've been invited to join the community "${community.name}"`,
        relatedEntity: {
          entityType: 'Community',
          entityId: community._id
        },
        isRead: false,
        priority: 'medium',
        actionUrl: `/api/communities/${community._id}/invitations/accept`
      });

      return res.json({ 
        success: true,
        message: `Invitation sent to @${userToInvite.username} successfully`,
        data: {
          invitedUser: {
            id: userToInvite._id,
            username: userToInvite.username,
            name: userToInvite.name || userToInvite.username
          }
        }
      });

    } catch (dbError) {
      console.error('Database error during invitation:', dbError);
      return res.status(500).json({ 
        success: false,
        message: 'Failed to send invitation. Please try again.'
      });
    }
  } catch (error) {
    console.error('Invite user error:', error);
    res.status(500).json({ 
      success: false,
      message: 'An unexpected error occurred. Please try again later.',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// @route   POST /api/communities/:id/profile-photo
// @desc    Upload community profile photo
// @access  Private
router.post('/:id/profile-photo', 
  authenticateToken,
  communityPhotoUpload.single('profilePhoto'),
  async (req, res) => {
    try {
      const community = await Community.findById(req.params.id);
      if (!community) {
        return res.status(404).json({ message: 'Community not found' });
      }

      // Check if user has permission to update community
      const isMember = community.members.some(member => 
        member.user.toString() === req.user._id.toString() && 
        (member.role === 'admin' || member.role === 'moderator')
      );

      if (!isMember && community.creator.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: 'Access denied' });
      }

      if (!req.file) {
        return res.status(400).json({ message: 'No file uploaded' });
      }

      // Delete old profile photo if exists
      if (community.profilePhoto) {
        const oldPhotoPath = community.profilePhoto.replace('/uploads/', 'uploads/');
        deleteOldImage(oldPhotoPath);
      }

      // Update community with new profile photo
      community.profilePhoto = `/uploads/communities/${req.file.filename}`;
      await community.save();

      // Populate the response with updated community data
      const updatedCommunity = await Community.findById(community._id)
        .populate('creator', 'firstName lastName username profilePicture')
        .populate('members.user', 'firstName lastName username profilePicture')
        .populate('moderators', 'firstName lastName username profilePicture')
        .populate('joinRequests.user', 'firstName lastName username profilePicture');

      return res.json({
        message: 'Profile photo updated successfully',
        community: updatedCommunity,
        profilePhoto: community.profilePhoto
      });
    } catch (error) {
      console.error('Upload profile photo error:', error);
      return res.status(500).json({ 
        message: 'Server error',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }
);

// @route   POST /api/communities/:id/cover
// @desc    Upload community cover image
// @access  Private
router.post('/:id/cover', authenticateToken, upload.single('coverImage'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    const community = await Community.findById(req.params.id);
    if (!community) {
      return res.status(404).json({ message: 'Community not found' });
    }

    // Check permissions
    const userMember = community.members.find(member => 
      member.user.toString() === req.user._id.toString()
    );

    if (!userMember || !['admin', 'moderator'].includes(userMember.role)) {
      return res.status(403).json({ message: 'You do not have permission to update this community' });
    }

    // Update cover image
    community.coverImage = `/uploads/communities/${req.file.filename}`;
    await community.save();

    res.json({
      message: 'Cover image updated successfully',
      coverImage: community.coverImage
    });
  } catch (error) {
    console.error('Upload cover image error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/communities/:id/join-requests/:requestId/approve
// @desc    Approve join request for private community
// @access  Private (Creator/Admin only)
router.post('/:id/join-requests/:requestId/approve', authenticateToken, async (req, res) => {
  try {
    const community = await Community.findById(req.params.id)
      .populate('joinRequests.user', 'firstName lastName email');
    
    if (!community) {
      return res.status(404).json({ message: 'Community not found' });
    }

    // Check if user is creator, app-level admin, or community-level admin/moderator
    const isCreator = community.creator.toString() === req.user._id.toString();
    const isAppAdmin = req.user.role === 'admin';
    const requesterMember = community.members.find(m => m.user.toString() === req.user._id.toString());
    const isCommunityAdminOrMod = requesterMember && ['admin', 'moderator'].includes(requesterMember.role);
  
    if (!isCreator && !isAppAdmin && !isCommunityAdminOrMod) {
      return res.status(403).json({ message: 'Only community creator, admin, or moderator can approve join requests' });
    }

    const joinRequest = community.joinRequests.id(req.params.requestId);
    if (!joinRequest) {
      return res.status(404).json({ message: 'Join request not found' });
    }

    if (joinRequest.status !== 'pending') {
      return res.status(400).json({ message: 'Join request has already been processed' });
    }

    // Approve the request
    joinRequest.status = 'approved';

    // Add user to community members
    community.members.push({
      user: joinRequest.user._id,
      role: 'member'
    });

    await community.save();

    // Add community to user's communities list
    await User.findByIdAndUpdate(joinRequest.user._id, {
      $addToSet: { communities: community._id }
    });

    // Create notification for the user
    const Notification = require('../models/Notification');
    await Notification.create({
      recipient: joinRequest.user._id,
      sender: req.user._id,
      type: 'join_approved',
      title: 'Join Request Approved',
      message: `Your request to join ${community.name} has been approved!`,
      relatedEntity: { entityType: 'Community', entityId: community._id },
      isRead: false,
      priority: 'low'
    });

    res.json({ message: 'Join request approved successfully' });
  } catch (error) {
    console.error('Approve join request error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/communities/:id/join-requests/:requestId/reject
// @desc    Reject join request for private community
// @access  Private (Creator/Admin only)
router.post('/:id/join-requests/:requestId/reject', authenticateToken, async (req, res) => {
  try {
    const { reason } = req.body;
    const community = await Community.findById(req.params.id)
      .populate('joinRequests.user', 'firstName lastName email');
    
    if (!community) {
      return res.status(404).json({ message: 'Community not found' });
    }

    // Check if user is creator, app-level admin, or community-level admin/moderator
    const isCreator = community.creator.toString() === req.user._id.toString();
    const isAppAdmin = req.user.role === 'admin';
    const requesterMember = community.members.find(m => m.user.toString() === req.user._id.toString());
    const isCommunityAdminOrMod = requesterMember && ['admin', 'moderator'].includes(requesterMember.role);
  
    if (!isCreator && !isAppAdmin && !isCommunityAdminOrMod) {
      return res.status(403).json({ message: 'Only community creator, admin, or moderator can reject join requests' });
    }

    const joinRequest = community.joinRequests.id(req.params.requestId);
    if (!joinRequest) {
      return res.status(404).json({ message: 'Join request not found' });
    }

    if (joinRequest.status !== 'pending') {
      return res.status(400).json({ message: 'Join request has already been processed' });
    }

    // Reject the request
    joinRequest.status = 'rejected';
    await community.save();

    // Create notification for the user
    const Notification = require('../models/Notification');
    await Notification.create({
      recipient: joinRequest.user._id,
      sender: req.user._id,
      type: 'join_rejected',
      title: 'Join Request Rejected',
      message: `Your request to join ${community.name} has been rejected.${reason ? ` Reason: ${reason}` : ''}`,
      relatedEntity: { entityType: 'Community', entityId: community._id },
      isRead: false,
      priority: 'low'
    });

    res.json({ message: 'Join request rejected successfully' });
  } catch (error) {
    console.error('Reject join request error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/communities/:id/join-requests
// @desc    Get pending join requests for a community
// @access  Private (Creator/Admin only)
router.get('/:id/join-requests', authenticateToken, async (req, res) => {
  try {
    const community = await Community.findById(req.params.id)
      .populate('joinRequests.user', 'firstName lastName email profilePicture')
      .select('joinRequests creator name');
    
    if (!community) {
      return res.status(404).json({ message: 'Community not found' });
    }

    // Check if user is creator or admin
    const isCreator = community.creator.toString() === req.user._id.toString();
    const isAdmin = req.user.role === 'admin';
    
    if (!isCreator && !isAdmin) {
      return res.status(403).json({ message: 'Only community creator or admin can view join requests' });
    }

    const pendingRequests = community.joinRequests.filter(request => request.status === 'pending');

    res.json({ joinRequests: pendingRequests });
  } catch (error) {
    console.error('Get join requests error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   DELETE /api/communities/:id
// @desc    Delete a community (admin only)
// @access  Private
router.delete('/:id', authenticateToken, async (req, res, next) => {
  try {
    // Pass-through to the consolidated delete handler below
    return next('route');
  } catch (error) {
    console.error('Error deleting community:', error);
    return res.status(500).json({ success: false, message: 'Error deleting community' });
  }
});

// @route   PUT /api/communities/:id
// @desc    Update community settings
// @access  Private (Members can edit name/description, Admin can edit privacy)
router.put('/:id', authenticateToken, [
  body('name')
    .optional()
    .trim()
    .isLength({ min: 3, max: 100 })
    .withMessage('Community name must be between 3 and 100 characters'),
  body('description')
    .optional()
    .trim()
    .isLength({ min: 10, max: 1000 })
    .withMessage('Description must be between 10 and 1000 characters'),
  body('isPrivate')
    .optional()
    .isBoolean()
    .withMessage('isPrivate must be a boolean')
], async (req, res) => {
  try {
    // Validate request body
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { name, description, isPrivate } = req.body;
    
    const community = await Community.findById(req.params.id);
    if (!community) {
      return res.status(404).json({ message: 'Community not found' });
    }

    // Check if user is a member
    const userMember = community.members.find(member => 
      member.user.toString() === req.user._id.toString()
    );

    if (!userMember) {
      return res.status(403).json({ message: 'Only community members can edit settings' });
    }

    // Check admin permissions for privacy changes
    const isCreator = community.creator.toString() === req.user._id.toString();
    const isAdmin = userMember.role === 'admin';
    const hasAdminPermissions = isCreator || isAdmin;

    // Update fields if provided
    const updates = {};
    
    if (name !== undefined) {
      updates.name = name.trim();
      
      // Check for duplicate community name (case-insensitive)
      if (name.toLowerCase() !== community.name.toLowerCase()) {
        const existingCommunity = await Community.findOne({
          name: { $regex: new RegExp(`^${name}$`, 'i') },
          _id: { $ne: community._id }
        });
        
        if (existingCommunity) {
          return res.status(400).json({ 
            message: 'A community with this name already exists' 
          });
        }
      }
    }

    if (description !== undefined) {
      updates.description = description.trim();
    }

    // Only allow privacy changes for admins
    if (isPrivate !== undefined) {
      if (!hasAdminPermissions) {
        return res.status(403).json({ 
          message: 'Only community admins can change privacy settings' 
        });
      }
      updates.isPrivate = isPrivate;
    }

    // Apply updates
    Object.assign(community, updates);
    await community.save();

    // Populate the response with all necessary fields
    const updatedCommunity = await Community.findById(community._id)
      .populate('creator', 'firstName lastName username profilePicture')
      .populate('members.user', 'firstName lastName username profilePicture')
      .populate('moderators', 'firstName lastName username profilePicture')
      .populate('joinRequests.user', 'firstName lastName username profilePicture');

    res.json({
      message: 'Community updated successfully',
      community: updatedCommunity
    });
  } catch (error) {
    console.error('Update community error:', error);
    
    // Handle duplicate key error
    if (error.code === 11000) {
      return res.status(400).json({ 
        message: 'A community with this name already exists' 
      });
    }
    
    res.status(500).json({ 
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// @route   DELETE /api/communities/:id
// @desc    Delete community
// @access  Private (Creator/Admin only)
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const community = await Community.findById(req.params.id);
    if (!community) {
      return res.status(404).json({ message: 'Community not found' });
    }

    // Check permissions - only creator or admin can delete
    const isCreator = community.creator.toString() === req.user._id.toString();
    const userMember = community.members.find(member => 
      member.user.toString() === req.user._id.toString()
    );
    const isAdmin = userMember && (userMember.role === 'admin' || userMember.role === 'creator');

    if (!isCreator && !isAdmin) {
      return res.status(403).json({ 
        message: 'Only community creator or admin can delete the community' 
      });
    }

    // Delete related data (with file cleanup)
    try {
      // 1) Clean up discussion files (attachments and profile photos)
      const discussionsWithFiles = await Discussion.find({ community: req.params.id }).select('attachments profilePhoto replies');
      for (const d of discussionsWithFiles) {
        if (Array.isArray(d.attachments)) {
          for (const att of d.attachments) {
            if (att?.path) {
              try {
                const rel = att.path.startsWith('/') ? att.path.slice(1) : att.path;
                const abs = path.join(__dirname, '..', rel);
                if (fs.existsSync(abs)) fs.unlinkSync(abs);
              } catch (e) { console.warn('Failed to remove discussion attachment:', e.message); }
            }
          }
        }
        // Reply-level attachments
        if (Array.isArray(d.replies)) {
          for (const r of d.replies) {
            if (Array.isArray(r.attachments)) {
              for (const att of r.attachments) {
                if (att?.path) {
                  try {
                    const rel = att.path.startsWith('/') ? att.path.slice(1) : att.path;
                    const abs = path.join(__dirname, '..', rel);
                    if (fs.existsSync(abs)) fs.unlinkSync(abs);
                  } catch (e) { console.warn('Failed to remove reply attachment:', e.message); }
                }
              }
            }
          }
        }
        if (typeof d.profilePhoto === 'string' && d.profilePhoto) {
          try {
            const rel = d.profilePhoto.startsWith('/') ? d.profilePhoto.slice(1) : d.profilePhoto;
            const abs = path.join(__dirname, '..', rel);
            if (fs.existsSync(abs)) fs.unlinkSync(abs);
          } catch (e) { console.warn('Failed to remove discussion profile photo:', e.message); }
        }
      }
      await Discussion.deleteMany({ community: req.params.id });
      
      // 2) Clean up resource files then delete resources
      const Resource = require('../models/Resource');
      const resources = await Resource.find({ community: req.params.id }).select('file.path');
      for (const r of resources) {
        const fp = r?.file?.path;
        if (fp) {
          try {
            const rel = fp.startsWith('/') ? fp.slice(1) : fp;
            const abs = path.join(__dirname, '..', rel);
            if (fs.existsSync(abs)) fs.unlinkSync(abs);
          } catch (e) { console.warn('Failed to remove resource file:', e.message); }
        }
      }
      await Resource.deleteMany({ community: req.params.id });
      
      // 3) Delete notifications related to this community
      const Notification = require('../models/Notification');
      await Notification.deleteMany({ 
        $or: [
          { 'data.communityId': req.params.id },
          { 'data.community': req.params.id },
          { referenceId: req.params.id }
        ]
      });

      // 4) Remove community from users' membership references
      await User.updateMany(
        { 'joinedCommunities.community': req.params.id },
        { $pull: { joinedCommunities: { community: req.params.id } } }
      );
      await User.updateMany(
        { communities: req.params.id },
        { $pull: { communities: req.params.id } }
      );

      // 5) Delete the community
      await Community.findByIdAndDelete(req.params.id);

      res.json({ 
        success: true,
        message: 'Community deleted successfully' 
      });
    } catch (error) {
      console.error('Error during community cleanup:', error);
      // Even if cleanup fails, we still want to delete the community
      await Community.findByIdAndDelete(req.params.id);
      res.json({ 
        success: true,
        message: 'Community deleted with some cleanup issues',
        warning: 'Some related data might not have been fully removed'
      });
    }
  } catch (error) {
    console.error('Delete community error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Failed to delete community',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// @route   DELETE /api/communities/:communityId/members/:userId
// @desc    Remove a member from community (admin only)
// @access  Private
router.delete('/:communityId/members/:userId', authenticateToken, async (req, res) => {
  try {
    const { communityId, userId } = req.params;
    const { _id: adminId } = req.user;

    // Find the community
    const community = await Community.findById(communityId);
    if (!community) {
      return res.status(404).json({ 
        success: false,
        message: 'Community not found' 
      });
    }

    // Check if requester is admin or creator
    const adminMember = community.members.find(member => 
      member.user.toString() === adminId.toString()
    );
    
    const isAdmin = adminMember && (adminMember.role === 'admin' || adminMember.role === 'creator');
    if (!isAdmin) {
      return res.status(403).json({ 
        success: false,
        message: 'Only community admins can remove members' 
      });
    }

    // Check if target user exists
    const userToRemove = await User.findById(userId);
    if (!userToRemove) {
      return res.status(404).json({ 
        success: false,
        message: 'User not found' 
      });
    }

    // Check if user is a member
    const memberIndex = community.members.findIndex(
      member => member.user.toString() === userId
    );

    if (memberIndex === -1) {
      return res.status(400).json({ 
        success: false,
        message: 'User is not a member of this community' 
      });
    }

    // Prevent removing creator
    if (community.creator.toString() === userId) {
      return res.status(400).json({ 
        success: false,
        message: 'Community creator cannot be removed' 
      });
    }

    // Remove member from community
    const removedMember = community.members[memberIndex];
    community.members.splice(memberIndex, 1);
    await community.save();

    // Remove community from user's joinedCommunities
    await User.findByIdAndUpdate(userId, {
      $pull: { 
        joinedCommunities: { community: communityId } 
      }
    });

    // Create notification for the removed user
    try {
      const Notification = require('../models/Notification');
      const notification = new Notification({
        recipient: userId,
        sender: adminId,
        type: 'system',
        title: 'Removed from Community',
        message: `You have been removed from the community "${community.name}"`,
        relatedEntity: { entityType: 'Community', entityId: community._id },
        isRead: false,
        priority: 'low'
      });
      await notification.save();
    } catch (notifError) {
      console.error('Failed to create removal notification:', notifError);
      // Continue even if notification fails
    }

    res.json({ 
      success: true,
      message: 'Member removed successfully',
      removedMember: {
        userId: removedMember.user,
        role: removedMember.role
      }
    });
  } catch (error) {
    console.error('Remove member error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Failed to remove member',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

module.exports = router;
