const nodemailer = require('nodemailer');

class EmailService {
  constructor() {
    this.transporter = nodemailer.createTransporter({
      host: process.env.EMAIL_HOST,
      port: process.env.EMAIL_PORT,
      secure: false,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });
  }

  async sendWelcomeEmail(user, verificationToken) {
    const verificationUrl = `${process.env.FRONTEND_URL}/verify-email/${verificationToken}`;
    
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: user.email,
      subject: 'Welcome to Discussify - Verify Your Email',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #2196F3;">Welcome to Discussify!</h2>
          <p>Hi ${user.firstName},</p>
          <p>Thank you for joining our community platform where you can connect with like-minded people, share your thoughts, and engage in meaningful conversations.</p>
          <p>Please verify your email address by clicking the button below:</p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${verificationUrl}" style="background-color: #2196F3; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">Verify Email</a>
          </div>
          <p>If the button doesn't work, you can copy and paste this link into your browser:</p>
          <p style="word-break: break-all; color: #666;">${verificationUrl}</p>
          <p>If you didn't create this account, please ignore this email.</p>
          <hr style="margin: 30px 0; border: none; border-top: 1px solid #eee;">
          <p style="color: #666; font-size: 12px;">Best regards,<br>The Discussify Team</p>
        </div>
      `
    };

    return await this.transporter.sendMail(mailOptions);
  }

  async sendPasswordResetEmail(user, resetToken) {
    const resetUrl = `${process.env.FRONTEND_URL}/reset-password/${resetToken}`;
    
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: user.email,
      subject: 'Password Reset - Discussify',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #f44336;">Password Reset Request</h2>
          <p>Hi ${user.firstName},</p>
          <p>You requested a password reset for your Discussify account. Click the button below to reset your password:</p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${resetUrl}" style="background-color: #f44336; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">Reset Password</a>
          </div>
          <p>This link will expire in 1 hour for security reasons.</p>
          <p>If you didn't request this password reset, please ignore this email and your password will remain unchanged.</p>
          <hr style="margin: 30px 0; border: none; border-top: 1px solid #eee;">
          <p style="color: #666; font-size: 12px;">Best regards,<br>The Discussify Team</p>
        </div>
      `
    };

    return await this.transporter.sendMail(mailOptions);
  }

  async sendCommunityInviteEmail(inviter, invitee, community) {
    const inviteUrl = `${process.env.FRONTEND_URL}/communities/${community._id}`;
    
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: invitee.email,
      subject: `You're invited to join ${community.name} on Discussify`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #4CAF50;">Community Invitation</h2>
          <p>Hi ${invitee.firstName},</p>
          <p><strong>${inviter.firstName} ${inviter.lastName}</strong> has invited you to join the <strong>${community.name}</strong> community on Discussify.</p>
          <div style="background-color: #f5f5f5; padding: 20px; border-radius: 5px; margin: 20px 0;">
            <h3 style="margin: 0 0 10px 0;">${community.name}</h3>
            <p style="margin: 0; color: #666;">${community.description}</p>
            <p style="margin: 10px 0 0 0;"><strong>Category:</strong> ${community.category}</p>
          </div>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${inviteUrl}" style="background-color: #4CAF50; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">Join Community</a>
          </div>
          <p>Join the conversation and connect with others who share your interests!</p>
          <hr style="margin: 30px 0; border: none; border-top: 1px solid #eee;">
          <p style="color: #666; font-size: 12px;">Best regards,<br>The Discussify Team</p>
        </div>
      `
    };

    return await this.transporter.sendMail(mailOptions);
  }

  async sendNotificationEmail(user, notification) {
    if (!user.notificationSettings.emailNotifications) {
      return; // User has disabled email notifications
    }

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: user.email,
      subject: `Discussify - ${notification.title}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #2196F3;">Discussify Notification</h2>
          <p>Hi ${user.firstName},</p>
          <h3>${notification.title}</h3>
          <p>${notification.message}</p>
          ${notification.actionUrl ? `
            <div style="text-align: center; margin: 30px 0;">
              <a href="${notification.actionUrl}" style="background-color: #2196F3; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">View Details</a>
            </div>
          ` : ''}
          <p>You can manage your notification preferences in your account settings.</p>
          <hr style="margin: 30px 0; border: none; border-top: 1px solid #eee;">
          <p style="color: #666; font-size: 12px;">Best regards,<br>The Discussify Team</p>
        </div>
      `
    };

    return await this.transporter.sendMail(mailOptions);
  }
}

module.exports = new EmailService();
