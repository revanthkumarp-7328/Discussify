const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { body, validationResult } = require('express-validator');
const Resource = require('../models/Resource');
const Community = require('../models/Community');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Configure multer for resource uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/resources/');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'resource-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE) || 50 * 1024 * 1024 // 50MB to match UI
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|pdf|doc|docx|txt|mp4|avi|mov|wmv|zip|rar|ppt|pptx|xls|xlsx|md|html/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype) || 
                     file.mimetype.includes('document') || 
                     file.mimetype.includes('text') ||
                     file.mimetype.includes('video') ||
                     file.mimetype.includes('application');

    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('File type not allowed'));
    }
  }
});

// Resource creation validation
const createResourceValidation = [
  body('title')
    .isLength({ min: 3, max: 200 })
    .withMessage('Title must be between 3 and 200 characters')
    .trim(),
  body('description')
    .isLength({ min: 10, max: 1000 })
    .withMessage('Description must be between 10 and 1000 characters')
    .trim(),
  body('type')
    .isIn(['article', 'video', 'document', 'link'])
    .withMessage('Invalid resource type'),
  body('communityId')
    .isMongoId()
    .withMessage('Valid community ID is required'),
  body('url')
    .optional()
    .isURL()
    .withMessage('Please provide a valid URL'),
  body('category')
    .optional()
    .isIn(['Educational', 'Tutorial', 'News', 'Research', 'Tool', 'Reference', 'Science', 'Technology', 'Other'])
    .withMessage('Invalid category')
];

// @route   POST /api/resources
// @desc    Create a new resource
// @access  Private
router.post('/', authenticateToken, upload.single('file'), createResourceValidation, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        message: errors.array().map(err => err.msg).join(', '),
        errors: errors.array()
      });
    }

    const { title, description, type, communityId, url, category = 'Other', tags = [] } = req.body;

    // Check if community exists and user is a member
    const community = await Community.findById(communityId);
    if (!community) {
      return res.status(404).json({ message: 'Community not found' });
    }

    const isMember = community.members.some(member => 
      member.user.toString() === req.user._id.toString()
    );

    if (!isMember) {
      return res.status(403).json({ message: 'You must be a member to share resources in this community' });
    }

    // Check community settings
    if (!community.settings.allowResourceSharing) {
      const userMember = community.members.find(member => 
        member.user.toString() === req.user._id.toString()
      );
      
      if (!['admin', 'moderator'].includes(userMember.role)) {
        return res.status(403).json({ message: 'Resource sharing is disabled in this community' });
      }
    }

    // Validate resource type requirements
    if (type === 'link' && !url) {
      return res.status(400).json({ message: 'URL is required for link resources' });
    }

    if (['article', 'document', 'video'].includes(type) && !req.file) {
      return res.status(400).json({ message: 'File upload is required for this resource type' });
    }

    // Process file if uploaded
    let fileData = null;
    if (req.file) {
      fileData = {
        filename: req.file.filename,
        originalName: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size,
        path: `/uploads/resources/${req.file.filename}`
      };
    }

    // Create resource
    const resource = new Resource({
      title,
      description,
      type,
      url: type === 'link' ? url : undefined,
      file: fileData,
      author: req.user._id,
      community: communityId,
      category,
      tags: Array.isArray(tags) ? tags.map(tag => tag.toLowerCase()) : [],
      metadata: {
        fileSize: req.file ? req.file.size : undefined
      }
    });

    await resource.save();

    // Update community stats
    await Community.findByIdAndUpdate(communityId, {
      $inc: { 'stats.resourceCount': 1 }
    });

    // Populate author for response
    await resource.populate('author', 'username firstName lastName profilePicture');

    res.status(201).json({
      message: 'Resource shared successfully',
      resource
    });
  } catch (error) {
    console.error('Create resource error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/resources
// @desc    Get resources with filters
// @access  Private
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { 
      communityId,
      page = 1, 
      limit = 10,
      type,
      category,
      search,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    const query = { isActive: true, isApproved: true };

    if (communityId) {
      // Verify user has access to this community (membership required unless site admin)
      const community = await Community.findById(communityId).select('members');
      if (!community) {
        return res.status(404).json({ message: 'Community not found' });
      }

      if (req.user.role !== 'admin') {
        const isMember = community.members.some(member => 
          member.user.toString() === req.user._id.toString()
        );
        if (!isMember) {
          return res.status(403).json({ message: 'Access denied: you must be a member of this community' });
        }
      }

      query.community = communityId;
    } else if (req.user.role !== 'admin') {
      // No specific community filter -> restrict to communities the user belongs to
      const myCommunities = await Community.find({ 'members.user': req.user._id }).select('_id');
      const allowedIds = myCommunities.map(c => c._id);
      if (allowedIds.length === 0) {
        return res.json({
          resources: [],
          pagination: {
            currentPage: parseInt(page),
            totalPages: 0,
            totalResources: 0,
            hasNext: false,
            hasPrev: false
          }
        });
      }
      query.community = { $in: allowedIds };
    }

    if (type) {
      query.type = type;
    }

    if (category) {
      query.category = category;
    }

    if (search) {
      const searchRegex = new RegExp(search, 'i');
      query.$or = [
        { title: searchRegex },
        { description: searchRegex },
        { tags: { $in: [searchRegex] } }
      ];
    }

    const sortOptions = {};
    sortOptions[sortBy] = sortOrder === 'desc' ? -1 : 1;

    const resources = await Resource.find(query)
      .populate('author', 'username firstName lastName profilePicture')
      .populate('community', 'name')
      .sort(sortOptions)
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit))
      .lean({ virtuals: true });

    const total = await Resource.countDocuments(query);

    res.json({
      resources,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / parseInt(limit)),
        totalResources: total,
        hasNext: parseInt(page) < Math.ceil(total / parseInt(limit)),
        hasPrev: parseInt(page) > 1
      }
    });
  } catch (error) {
    console.error('Get resources error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/resources/:id
// @desc    Get resource by ID
// @access  Private
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const resource = await Resource.findById(req.params.id)
      .populate('author', 'username firstName lastName profilePicture')
      .populate('community', 'name isPrivate members')
      .populate('comments.author', 'username firstName lastName profilePicture')
      .populate('likes.user', 'username firstName lastName');

    if (!resource) {
      return res.status(404).json({ message: 'Resource not found' });
    }

    // Check access: membership required unless site admin
    if (req.user.role !== 'admin') {
      const isMember = resource.community.members.some(member => 
        member.user.toString() === req.user._id.toString()
      );
      if (!isMember) {
        return res.status(403).json({ message: 'Access denied: you must be a member of this community' });
      }
    }

    res.json({ resource });
  } catch (error) {
    console.error('Get resource error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/resources/:id/like
// @desc    Like/unlike a resource
// @access  Private
router.post('/:id/like', authenticateToken, async (req, res) => {
  try {
    const resource = await Resource.findById(req.params.id);

    if (!resource) {
      return res.status(404).json({ message: 'Resource not found' });
    }

    const likeIndex = resource.likes.findIndex(like => 
      like.user.toString() === req.user._id.toString()
    );

    if (likeIndex > -1) {
      // Unlike
      resource.likes.splice(likeIndex, 1);
      await resource.save();
      res.json({ message: 'Resource unliked', liked: false });
    } else {
      // Like
      resource.likes.push({
        user: req.user._id,
        likedAt: new Date()
      });
      await resource.save();
      res.json({ message: 'Resource liked', liked: true });
    }
  } catch (error) {
    console.error('Like resource error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/resources/:id/download
// @desc    Download a resource file
// @access  Private
router.get('/:id/download', authenticateToken, async (req, res) => {
  try {
    const resource = await Resource.findById(req.params.id);

    if (!resource) {
      return res.status(404).json({ message: 'Resource not found' });
    }

    if (!resource.file || !resource.file.path) {
      return res.status(400).json({ message: 'No file available for download' });
    }

    // Check if user is a member of the community (admin bypass)
    const community = await Community.findById(resource.community);
    if (req.user.role !== 'admin') {
      const isMember = community.members.some(member => 
        member.user.toString() === req.user._id.toString()
      );
      if (!isMember) {
        return res.status(403).json({ message: 'You must be a member to download this resource' });
      }
    }

    // Track download if not already downloaded by this user
    const hasDownloaded = resource.downloads.some(download => 
      download.user.toString() === req.user._id.toString()
    );

    if (!hasDownloaded) {
      resource.downloads.push({
        user: req.user._id,
        downloadedAt: new Date()
      });
      await resource.save();
    }

    // Get the file path and set appropriate headers (handle leading '/')
    const relativePath = resource.file.path.startsWith('/') ? resource.file.path.slice(1) : resource.file.path;
    const filePath = path.join(__dirname, '..', relativePath);
    const fileName = resource.file.originalName || path.basename(filePath);

    // Verify file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ message: 'File not found on server' });
    }
    
    // Set headers for file download
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', resource.file.mimetype || 'application/octet-stream');
    // Expose filename header to browsers in CORS environment
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    
    // Stream the file to the response
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);
    
    // Handle errors during file streaming
    fileStream.on('error', (error) => {
      console.error('File stream error:', error);
      if (!res.headersSent) {
        res.status(500).json({ message: 'Error streaming file' });
      }
    });
    
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ 
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// @route   POST /api/resources/:id/comment
// @desc    Add comment to resource
// @access  Private
router.post('/:id/comment', authenticateToken, [
  body('content')
    .isLength({ min: 1, max: 500 })
    .withMessage('Comment must be between 1 and 500 characters')
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
    const resource = await Resource.findById(req.params.id)
      .populate('community', 'members isPrivate');

    if (!resource) {
      return res.status(404).json({ message: 'Resource not found' });
    }

    // Check if user is member of community
    const isMember = resource.community.members.some(member => 
      member.user.toString() === req.user._id.toString()
    );

    if (!isMember) {
      return res.status(403).json({ message: 'You must be a member to comment' });
    }

    // Add comment
    const comment = {
      author: req.user._id,
      content,
      createdAt: new Date()
    };

    resource.comments.push(comment);
    await resource.save();

    // Populate the new comment
    await resource.populate('comments.author', 'username firstName lastName profilePicture');

    const newComment = resource.comments[resource.comments.length - 1];

    res.status(201).json({
      message: 'Comment added successfully',
      comment: newComment
    });
  } catch (error) {
    console.error('Add comment error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   PUT /api/resources/:id
// @desc    Update resource
// @access  Private
router.put('/:id', authenticateToken, upload.single('file'), [
  body('title')
    .optional()
    .isLength({ min: 3, max: 200 })
    .withMessage('Title must be between 3 and 200 characters')
    .trim(),
  body('description')
    .optional()
    .isLength({ min: 10, max: 1000 })
    .withMessage('Description must be between 10 and 1000 characters')
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

    const resource = await Resource.findById(req.params.id);

    if (!resource) {
      return res.status(404).json({ message: 'Resource not found' });
    }

    // Authorization: only resource author or site admin can update
    if (resource.author.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only the author or an admin can edit this resource' });
    }

    const { title, description, tags, category, url } = req.body;

    if (title) resource.title = title;
    if (description) resource.description = description;
    if (tags) {
      let parsed = tags;
      if (typeof tags === 'string') {
        try { parsed = JSON.parse(tags); } catch { parsed = [tags]; }
      }
      if (Array.isArray(parsed)) {
        resource.tags = parsed.map(tag => String(tag).toLowerCase());
      }
    }
    if (category) resource.category = category;

    // Update URL for link resources
    if (resource.type === 'link' && typeof url === 'string') {
      if (!/^https?:\/\//i.test(url)) {
        return res.status(400).json({ message: 'Please provide a valid URL starting with http:// or https://' });
      }
      resource.url = url;
    }

    // If a new file is uploaded and resource type uses file (article/document/video), replace it
    if (req.file) {
      if (resource.type === 'link') {
        return res.status(400).json({ message: 'Link resources do not accept file uploads' });
      }

      // Remove old file if exists
      if (resource.file?.path) {
        try {
          const oldRel = resource.file.path.startsWith('/') ? resource.file.path.slice(1) : resource.file.path;
          const oldAbs = path.join(__dirname, '..', oldRel);
          if (fs.existsSync(oldAbs)) {
            fs.unlinkSync(oldAbs);
          }
        } catch (e) {
          console.warn('Failed to remove old resource file:', e.message);
        }
      }

      resource.file = {
        filename: req.file.filename,
        originalName: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size,
        path: `/uploads/resources/${req.file.filename}`
      };
      resource.metadata = {
        ...(resource.metadata || {}),
        fileSize: req.file.size
      };
    }

    await resource.save();

    // Populate author for response consistency
    await resource.populate('author', 'username firstName lastName profilePicture');
    res.json({
      message: 'Resource updated successfully',
      resource
    });
  } catch (error) {
    console.error('Update resource error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   DELETE /api/resources/:id
// @desc    Delete resource
// @access  Private
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const resource = await Resource.findById(req.params.id);

    if (!resource) {
      return res.status(404).json({ message: 'Resource not found' });
    }

    // Authorization: only resource author or site admin can delete
    if (resource.author.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only the author or an admin can delete this resource' });
    }

    // Remove file from disk if exists
    if (resource.file?.path) {
      try {
        const rel = resource.file.path.startsWith('/') ? resource.file.path.slice(1) : resource.file.path;
        const abs = path.join(__dirname, '..', rel);
        if (fs.existsSync(abs)) {
          fs.unlinkSync(abs);
        }
      } catch (e) {
        console.warn('Failed to remove resource file on delete:', e.message);
      }
    }

    await Resource.findByIdAndDelete(req.params.id);

    // Update community stats
    await Community.findByIdAndUpdate(resource.community, {
      $inc: { 'stats.resourceCount': -1 }
    });

    res.json({ message: 'Resource deleted successfully' });
  } catch (error) {
    console.error('Delete resource error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
