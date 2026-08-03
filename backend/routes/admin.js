const express = require('express');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const Community = require('../models/Community');
const Discussion = require('../models/Discussion');
const Resource = require('../models/Resource');
const Notification = require('../models/Notification');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// Apply admin middleware to all routes
router.use(authenticateToken);
router.use(requireAdmin);

// @route   GET /api/admin/stats
// @desc    Get platform statistics
// @access  Admin
router.get('/stats', async (req, res) => {
  try {
    const userStats = await User.aggregate([
      {
        $group: {
          _id: null,
          totalUsers: { $sum: 1 },
          activeUsers: { $sum: { $cond: [{ $eq: ['$isActive', true] }, 1, 0] } },
          verifiedUsers: { $sum: { $cond: [{ $eq: ['$isEmailVerified', true] }, 1, 0] } }
        }
      }
    ]);

    const communityStats = await Community.aggregate([
      {
        $group: {
          _id: null,
          totalCommunities: { $sum: 1 },
          activeCommunities: { $sum: { $cond: [{ $eq: ['$isActive', true] }, 1, 0] } },
          privateCommunities: { $sum: { $cond: [{ $eq: ['$isPrivate', true] }, 1, 0] } }
        }
      }
    ]);

    const discussionCount = await Discussion.countDocuments();
    const resourceCount = await Resource.countDocuments();

    const recentUsers = await User.find({ isActive: true })
      .sort({ createdAt: -1 })
      .limit(5)
      .select('username firstName lastName createdAt');

    const communities = await Community.find()
      .populate('creator', 'firstName lastName email')
      .sort({ createdAt: -1 })
      .limit(50);

    // Add pending requests count to each community
    const communitiesWithRequests = communities.map(community => {
      const communityObj = community.toObject();
      communityObj.pendingRequests = community.joinRequests ? 
        community.joinRequests.filter(req => req.status === 'pending').length : 0;
      return communityObj;
    });

    res.json({
      stats: {
        users: userStats[0] || { totalUsers: 0, activeUsers: 0, verifiedUsers: 0 },
        communities: communityStats[0] || { totalCommunities: 0, activeCommunities: 0, privateCommunities: 0 },
        discussions: discussionCount,
        resources: resourceCount
      },
      recentActivity: {
        users: recentUsers,
        communities: communitiesWithRequests
      }
    });
  } catch (error) {
    console.error('Get admin stats error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/admin/users
// @desc    Get all users with pagination
// @access  Admin
router.get('/users', async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 20,
      search,
      isActive,
      role,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    const query = {};

    if (search) {
      const searchRegex = new RegExp(search, 'i');
      query.$or = [
        { username: searchRegex },
        { email: searchRegex },
        { firstName: searchRegex },
        { lastName: searchRegex }
      ];
    }

    if (isActive !== undefined) {
      query.isActive = isActive === 'true';
    }

    if (role) {
      query.role = role;
    }

    const sortOptions = {};
    sortOptions[sortBy] = sortOrder === 'desc' ? -1 : 1;

    const users = await User.find(query)
      .select('-password')
      .populate('communities', 'name')
      .sort(sortOptions)
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));

    const total = await User.countDocuments(query);

    res.json({
      users,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / parseInt(limit)),
        totalUsers: total,
        hasNext: parseInt(page) < Math.ceil(total / parseInt(limit)),
        hasPrev: parseInt(page) > 1
      }
    });
  } catch (error) {
    console.error('Get admin users error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   PUT /api/admin/users/:id/status
// @desc    Update user status (activate/deactivate)
// @access  Admin
router.put('/users/:id/status', [
  body('isActive').isBoolean().withMessage('isActive must be a boolean')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { isActive } = req.body;
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Prevent admin from deactivating themselves
    if (req.params.id === req.user._id.toString()) {
      return res.status(400).json({ message: 'You cannot deactivate your own account' });
    }

    user.isActive = isActive;
    await user.save();

    res.json({
      message: `User ${isActive ? 'activated' : 'deactivated'} successfully`,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        isActive: user.isActive
      }
    });
  } catch (error) {
    console.error('Update user status error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   PUT /api/admin/users/:id/role
// @desc    Update user role
// @access  Admin
router.put('/users/:id/role', [
  body('role').isIn(['user', 'admin']).withMessage('Invalid role')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { role } = req.body;
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    user.role = role;
    await user.save();

    res.json({
      message: `User role updated to ${role} successfully`,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Update user role error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   DELETE /api/admin/users/:id
// @desc    Delete user account
// @access  Admin
router.delete('/users/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Prevent admin from deleting themselves
    if (req.params.id === req.user._id.toString()) {
      return res.status(400).json({ message: 'You cannot delete your own account' });
    }

    // Check if user has active communities as creator
    const userCommunities = await Community.find({ creator: req.params.id, isActive: true });
    
    if (userCommunities.length > 0) {
      return res.status(400).json({ 
        message: 'Cannot delete user who is creator of active communities. Transfer ownership first.',
        activeCommunities: userCommunities.map(c => ({ id: c._id, name: c.name }))
      });
    }

    // Remove user from all communities
    await Community.updateMany(
      { 'members.user': req.params.id },
      { $pull: { members: { user: req.params.id } } }
    );

    // Delete user's discussions and resources
    await Discussion.deleteMany({ author: req.params.id });
    await Resource.deleteMany({ author: req.params.id });
    await Notification.deleteMany({ 
      $or: [{ recipient: req.params.id }, { sender: req.params.id }] 
    });

    // Delete user
    await User.findByIdAndDelete(req.params.id);

    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/admin/communities
// @desc    Get all communities with pagination
// @access  Admin
router.get('/communities', async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 20,
      search,
      category,
      isActive,
      isPrivate,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    const query = {};

    if (search) {
      const searchRegex = new RegExp(search, 'i');
      query.$or = [
        { name: searchRegex },
        { description: searchRegex }
      ];
    }

    if (category) {
      query.category = category;
    }

    if (isActive !== undefined) {
      query.isActive = isActive === 'true';
    }

    if (isPrivate !== undefined) {
      query.isPrivate = isPrivate === 'true';
    }

    const sortOptions = {};
    sortOptions[sortBy] = sortOrder === 'desc' ? -1 : 1;

    const communities = await Community.find(query)
      .populate('creator', 'username firstName lastName email')
      .populate('moderators', 'username firstName lastName')
      .sort(sortOptions)
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));

    // Add pending requests count to each community
    const communitiesWithRequests = communities.map(community => {
      const communityObj = community.toObject();
      communityObj.pendingRequests = community.joinRequests ? 
        community.joinRequests.filter(req => req.status === 'pending').length : 0;
      return communityObj;
    });

    const total = await Community.countDocuments(query);

    res.json({
      communities: communitiesWithRequests,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / parseInt(limit)),
        totalCommunities: total,
        hasNext: parseInt(page) < Math.ceil(total / parseInt(limit)),
        hasPrev: parseInt(page) > 1
      }
    });
  } catch (error) {
    console.error('Get admin communities error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   PUT /api/admin/communities/:id/status
// @desc    Update community status (activate/deactivate)
// @access  Admin
router.put('/communities/:id/status', [
  body('isActive').isBoolean().withMessage('isActive must be a boolean')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { isActive } = req.body;
    const community = await Community.findById(req.params.id);

    if (!community) {
      return res.status(404).json({ message: 'Community not found' });
    }

    community.isActive = isActive;
    await community.save();

    res.json({
      message: `Community ${isActive ? 'activated' : 'deactivated'} successfully`,
      community: {
        id: community._id,
        name: community.name,
        isActive: community.isActive
      }
    });
  } catch (error) {
    console.error('Update community status error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   DELETE /api/admin/communities/:id
// @desc    Delete community
// @access  Admin
router.delete('/communities/:id', async (req, res) => {
  try {
    const community = await Community.findById(req.params.id);

    if (!community) {
      return res.status(404).json({ message: 'Community not found' });
    }

    // Check if community has active discussions
    const activeDiscussions = await Discussion.countDocuments({ 
      community: req.params.id 
    });

    if (activeDiscussions > 0) {
      return res.status(400).json({ 
        message: `Cannot delete community with ${activeDiscussions} active discussions. Archive discussions first.`
      });
    }

    // Remove community from all users
    await User.updateMany(
      { communities: req.params.id },
      { $pull: { communities: req.params.id } }
    );

    // Delete community resources
    await Resource.deleteMany({ community: req.params.id });

    // Delete community
    await Community.findByIdAndDelete(req.params.id);

    res.json({ message: 'Community deleted successfully' });
  } catch (error) {
    console.error('Delete community error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/admin/reports
// @desc    Get platform reports and analytics
// @access  Admin
router.get('/reports', async (req, res) => {
  try {
    const { period = '30' } = req.query; // days
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(period));

    // User registration trends
    const userRegistrations = await User.aggregate([
      {
        $match: { createdAt: { $gte: startDate } }
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$createdAt' }
          },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    // Community creation trends
    const communityCreations = await Community.aggregate([
      {
        $match: { createdAt: { $gte: startDate } }
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$createdAt' }
          },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    // Discussion activity
    const discussionActivity = await Discussion.aggregate([
      {
        $match: { createdAt: { $gte: startDate } }
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$createdAt' }
          },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    // Top communities by member count
    const topCommunities = await Community.find({ isActive: true })
      .sort({ 'stats.memberCount': -1 })
      .limit(10)
      .select('name stats category')
      .populate('creator', 'username');

    // Most active users
    const activeUsers = await Discussion.aggregate([
      {
        $match: { createdAt: { $gte: startDate } }
      },
      {
        $group: {
          _id: '$author',
          discussionCount: { $sum: 1 }
        }
      },
      { $sort: { discussionCount: -1 } },
      { $limit: 10 },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'user'
        }
      },
      {
        $project: {
          user: { $arrayElemAt: ['$user', 0] },
          discussionCount: 1
        }
      }
    ]);

    res.json({
      period: parseInt(period),
      trends: {
        userRegistrations,
        communityCreations,
        discussionActivity
      },
      topCommunities,
      activeUsers
    });
  } catch (error) {
    console.error('Get admin reports error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
